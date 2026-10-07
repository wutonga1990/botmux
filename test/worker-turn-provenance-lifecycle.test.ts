import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import esbuild from 'esbuild';
import {
  authorizeReportSessionRelayRequest,
  type ReportSessionRelaySessionView,
} from '../src/core/report-session-relay.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

const CAPABILITY_A = 'a'.repeat(64);
const CAPABILITY_B = 'b'.repeat(64);
const BINDING_SECRET = 'binding-secret';
const REGISTRY = {
  om_seed: {
    orchAppId: 'cli_orch',
    orchSessionId: 'session-orch',
    title: '任务回报',
    reportBinding: createDispatchReportBinding(BINDING_SECRET, {
      dispatchRoot: 'om_seed',
      targetLarkAppId: 'cli_orch',
      targetSessionId: 'session-orch',
      sourceName: '任务回报',
      issuedAt: '2026-10-06T08:00:00.000Z',
    }),
  },
};

function buildSession(overrides: Partial<ReportSessionRelaySessionView> = {}): ReportSessionRelaySessionView {
  return {
    sessionId: 'worker-session',
    larkAppId: 'cli_worker',
    receiver: false,
    scope: 'thread',
    rootMessageId: 'om_seed',
    liveOrigin: { capability: CAPABILITY_A, turnId: 'turn-1', dispatchAttempt: 1 },
    ...overrides,
  };
}

function verifyReportRelay(sessionView: ReportSessionRelaySessionView, capability = CAPABILITY_A) {
  return authorizeReportSessionRelayRequest({
    raw: {
      sessionId: 'worker-session',
      dispatchRoot: 'om_seed',
      content: '子项目完成',
      originCapability: capability,
    },
    trustedHost: false,
    session: sessionView,
    selfLarkAppId: 'cli_worker',
    registry: REGISTRY,
    bindingSecret: BINDING_SECRET,
  });
}

function runPromptReady(sandbox: Record<string, any>) {
  const defaultSandbox: Record<string, any> = {
    promptReadyEdges: 0,
    settleSessionRenameOnPrompt: () => {},
    releaseRawInputRestartGate: () => {},
    consecutiveInWorkerRestarts: 0,
    inflightInputs: { onTurnComplete: () => {} },
    stuckDetector: { disarm: () => {} },
    maybeEmitWorkflowTranscriptOutput: () => {},
    awaitingFirstPrompt: false,
    send: () => {},
    codexAutoUpgrade: null,
    codexUpgradeTimer: null,
    persistCodexRunnerBuildOnReady: false,
    renderer: null,
    activeRestartAttemptId: undefined,
    pendingMessages: [],
    pendingAdoptMessages: [],
    pendingRawInputs: [],
    pendingSessionRename: null,
    isFlushing: false,
    shouldFlushInjectionsFirst: () => false,
    flushPending: () => {},
    pendingInjections: [],
    spawnArgvNeedsWorkingSeed: false,
  };
  const promptStart = workerSource.indexOf('function markPromptReady(): void {');
  const promptEnd = workerSource.indexOf('\nfunction persistCliSessionId(', promptStart);
  const fnSource = workerSource.slice(promptStart, promptEnd);
  const jsCode = esbuild.transformSync(`${fnSource}\nmarkPromptReady();`, { loader: 'ts' }).code;
  const vmScript = new vm.Script(jsCode);
  const context = vm.createContext({ ...defaultSandbox, ...sandbox });
  vmScript.runInContext(context);
}

describe('worker turn provenance lifecycle (#1723)', () => {
  describe('source ordering and wiring checks', () => {
    it('checks backgroundTaskTracker BEFORE revoking active turn authority in markPromptReady', () => {
      const promptStart = workerSource.indexOf('function markPromptReady(): void');
      const promptEnd = workerSource.indexOf('\nfunction persistCliSessionId(', promptStart);
      expect(promptStart).toBeGreaterThanOrEqual(0);
      expect(promptEnd).toBeGreaterThan(promptStart);

      const promptBody = workerSource.slice(promptStart, promptEnd);
      const revokeIdx = promptBody.indexOf("releaseActiveTurnAuthority('prompt_ready')");
      expect(revokeIdx).toBeGreaterThan(0);

      // backgroundTaskTracker.pending() must be checked and handled before releaseActiveTurnAuthority
      const bgCheckIdx = promptBody.indexOf('backgroundTaskTracker.pending() > 0');
      expect(bgCheckIdx).toBeGreaterThanOrEqual(0);
      expect(bgCheckIdx).toBeLessThan(revokeIdx);
    });

    it('propagates revoke reason in completeManagedTurnOriginRevocation and managed_turn_origin_revoked', () => {
      const completeRevokeStart = workerSource.indexOf('function completeManagedTurnOriginRevocation(');
      const completeRevokeEnd = workerSource.indexOf('function revokeManagedTurnOriginForRestart()', completeRevokeStart);
      const completeRevokeBody = workerSource.slice(completeRevokeStart, completeRevokeEnd);

      expect(completeRevokeBody).toContain('reason?: string');
      expect(completeRevokeBody).toContain('type: \'managed_turn_origin_revoked\'');
      expect(completeRevokeBody).toContain('opts.reason');

      const releaseAuthorityStart = workerSource.indexOf('function releaseActiveTurnAuthority(');
      const releaseAuthorityEnd = workerSource.indexOf('function currentGatewayTrustedTurnIdentity()', releaseAuthorityStart);
      const releaseAuthorityBody = workerSource.slice(releaseAuthorityStart, releaseAuthorityEnd);
      expect(releaseAuthorityBody).toContain('reason');
    });

    it('records diagnostics for managed_turn_origin_revoked in worker-pool without logging capabilities', () => {
      const handlerStart = workerPoolSource.indexOf("case 'managed_turn_origin_revoked':");
      const handlerEnd = workerPoolSource.indexOf("case 'codex_app_dispatch_transition':", handlerStart);
      const handlerBody = workerPoolSource.slice(handlerStart, handlerEnd);

      expect(handlerBody).toContain('logger.info(');
      expect(handlerBody).toContain('Managed turn origin revoked');
      expect(handlerBody).toContain('reason');
      expect(handlerBody).toContain('ds.workerGeneration');
      // Do NOT log capability tokens
      expect(handlerBody).not.toContain('capability: msg.capability');
      expect(handlerBody).not.toContain('${msg.capability}');
    });
  });

  describe('end-to-end provenance authorization and lifecycle regression', () => {
    it('scenario 1: fresh turn publishes origin and authorizes report relay', () => {
      const liveSession = buildSession({
        liveOrigin: { capability: CAPABILITY_A, turnId: 'turn-1', dispatchAttempt: 1 },
      });
      const result = verifyReportRelay(liveSession, CAPABILITY_A);
      expect(result).toMatchObject({
        ok: true,
        source: { sessionId: 'worker-session', larkAppId: 'cli_worker' },
        target: { larkAppId: 'cli_orch', sessionId: 'session-orch' },
      });
    });

    it('scenario 2: unfinished background tasks retain turn authority during prompt-ready heuristic and re-arm working', () => {
      // Reproduce prompt-ready execution with backgroundTaskTracker.pending() === 1
      const events: any[] = [];
      let authorityReleased = false;

      const sandbox: Record<string, any> = {
        idleDetector: { isStartupPending: () => false, reset: () => events.push('idle_reset') },
        bareShellLaunchBlocked: false,
        currentInputDeliveryQuarantine: () => false,
        isPromptReady: false,
        stopStructuredStartGraceRecheck: () => {},
        lastInitConfig: { cliId: 'antigravity' },
        cliRestartInProgress: false,
        replacementSpawnInProgress: false,
        stopBusyPatternIdleProbe: () => {},
        readyGate: { shouldHold: () => false },
        awaitingPostSessionStartPromptEvidence: false,
        isSettlingFirstFlush: false,
        freshnessInputQueue: { onPromptReady: () => 'normal' },
        spawnArgvTurnStartGateHolds: () => false,
        hasStructuredLifecycleBlock: () => false,
        spawnArgvInitialPromptBusy: false,
        durableTurnInFlight: false,
        preserveActiveTurnAuthorityForReady: false,
        releaseActiveTurnAuthority: (reason: string) => {
          authorityReleased = true;
          events.push({ type: 'release_authority', reason });
        },
        backgroundTaskTracker: { pending: () => 1 },
        publishScreenStatus: (status: string) => events.push({ type: 'screen_status', status }),
        log: (msg: string) => events.push({ type: 'log', msg }),
        backend: { id: 'pty-1' },
        renderer: { snapshot: () => ({ content: '' }) },
        pendingMessages: [],
        pendingAdoptMessages: [],
        pendingRawInputs: [],
        pendingSessionRename: null,
        isFlushing: false,
      };

      runPromptReady(sandbox);

      // Must NOT release turn authority when background tasks are pending
      expect(authorityReleased).toBe(false);
      // Screen status must report working, and idle detector must be re-armed
      expect(events).toContainEqual(expect.objectContaining({ type: 'screen_status', status: 'working' }));
      expect(events).toContain('idle_reset');

      // Because authority was NOT released, the session's liveOrigin remains intact
      const liveSession = buildSession({
        liveOrigin: { capability: CAPABILITY_A, turnId: 'turn-1', dispatchAttempt: 1 },
      });
      const reportResult = verifyReportRelay(liveSession, CAPABILITY_A);
      expect(reportResult.ok).toBe(true);
    });

    it('scenario 3: inbound pending messages flush without releasing turn authority while background tasks are pending', () => {
      const events: any[] = [];
      let authorityReleased = false;
      let flushPendingCalled = false;

      const sandbox: Record<string, any> = {
        idleDetector: { isStartupPending: () => false, reset: () => events.push('idle_reset') },
        bareShellLaunchBlocked: false,
        currentInputDeliveryQuarantine: () => false,
        isPromptReady: false,
        stopStructuredStartGraceRecheck: () => {},
        lastInitConfig: { cliId: 'opencode2' },
        cliRestartInProgress: false,
        replacementSpawnInProgress: false,
        stopBusyPatternIdleProbe: () => {},
        readyGate: { shouldHold: () => false },
        awaitingPostSessionStartPromptEvidence: false,
        isSettlingFirstFlush: false,
        freshnessInputQueue: { onPromptReady: () => 'normal' },
        spawnArgvTurnStartGateHolds: () => false,
        hasStructuredLifecycleBlock: () => false,
        spawnArgvInitialPromptBusy: false,
        durableTurnInFlight: false,
        preserveActiveTurnAuthorityForReady: false,
        releaseActiveTurnAuthority: (reason: string) => {
          authorityReleased = true;
          events.push({ type: 'release_authority', reason });
        },
        backgroundTaskTracker: { pending: () => 1 },
        publishScreenStatus: (status: string) => events.push({ type: 'screen_status', status }),
        log: (msg: string) => events.push({ type: 'log', msg }),
        backend: { id: 'pty-1' },
        renderer: { snapshot: () => ({ content: '' }) },
        send: (msg: any) => events.push({ type: 'ipc', msg }),
        pendingMessages: [{ text: 'inbound message while task pending' }],
        pendingAdoptMessages: [],
        pendingRawInputs: [],
        pendingSessionRename: null,
        isFlushing: false,
        flushPending: () => {
          flushPendingCalled = true;
          events.push('flush_pending');
        },
      };

      runPromptReady(sandbox);

      // Must NOT release turn authority
      expect(authorityReleased).toBe(false);
      // Must flush pending messages to CLI immediately
      expect(flushPendingCalled).toBe(true);
      // Must emit prompt_ready IPC to daemon
      expect(events).toContainEqual(expect.objectContaining({ type: 'ipc', msg: expect.objectContaining({ type: 'prompt_ready' }) }));

      // Because authority was NOT released, report relay continues to succeed
      const liveSession = buildSession({
        liveOrigin: { capability: CAPABILITY_A, turnId: 'turn-1', dispatchAttempt: 1 },
      });
      const reportResult = verifyReportRelay(liveSession, CAPABILITY_A);
      expect(reportResult.ok).toBe(true);
    });

    it('scenario 4: genuine completion revokes turn-1, and subsequent inbound turn gets fresh authorized origin', () => {
      // Step A: Genuine completion (no pending tasks, not busy)
      const events: any[] = [];
      let authorityReleased = false;
      let releasedReason = '';

      const sandbox: Record<string, any> = {
        idleDetector: { isStartupPending: () => false, reset: () => events.push('idle_reset') },
        bareShellLaunchBlocked: false,
        currentInputDeliveryQuarantine: () => false,
        isPromptReady: false,
        stopStructuredStartGraceRecheck: () => {},
        lastInitConfig: { cliId: 'antigravity' },
        cliRestartInProgress: false,
        replacementSpawnInProgress: false,
        stopBusyPatternIdleProbe: () => {},
        readyGate: { shouldHold: () => false },
        awaitingPostSessionStartPromptEvidence: false,
        isSettlingFirstFlush: false,
        freshnessInputQueue: { onPromptReady: () => 'normal' },
        spawnArgvTurnStartGateHolds: () => false,
        hasStructuredLifecycleBlock: () => false,
        spawnArgvInitialPromptBusy: false,
        durableTurnInFlight: false,
        preserveActiveTurnAuthorityForReady: false,
        releaseActiveTurnAuthority: (reason: string) => {
          authorityReleased = true;
          releasedReason = reason;
          events.push({ type: 'release_authority', reason });
        },
        backgroundTaskTracker: { pending: () => 0 },
        publishScreenStatus: (status: string) => events.push({ type: 'screen_status', status }),
        log: (msg: string) => events.push({ type: 'log', msg }),
        backend: { id: 'pty-1' },
        deferPromptReadyWhileBusy: () => false,
        promptReadyEdges: 0,
        settleSessionRenameOnPrompt: () => {},
        releaseRawInputRestartGate: () => {},
        consecutiveInWorkerRestarts: 0,
        inflightInputs: { onTurnComplete: () => {} },
        stuckDetector: { disarm: () => {} },
        maybeEmitWorkflowTranscriptOutput: () => {},
        awaitingFirstPrompt: false,
        send: (msg: any) => events.push({ type: 'ipc', msg }),
        codexAutoUpgrade: null,
        codexUpgradeTimer: null,
        persistCodexRunnerBuildOnReady: false,
        renderer: null,
        activeRestartAttemptId: undefined,
        pendingMessages: [],
        pendingAdoptMessages: [],
        pendingRawInputs: [],
        pendingSessionRename: null,
        isFlushing: false,
        shouldFlushInjectionsFirst: () => false,
        flushPending: () => {},
        pendingInjections: [],
      };

      runPromptReady(sandbox);

      expect(authorityReleased).toBe(true);
      expect(releasedReason).toBe('prompt_ready');

      // Step B: Once turn-1 is revoked, report relay for turn-1 is rejected as stale
      const staleSession = buildSession({
        liveOrigin: { capability: CAPABILITY_A }, // Revoked (no turnId)
      });
      const staleResult = verifyReportRelay(staleSession, CAPABILITY_A);
      expect(staleResult).toEqual({ ok: false, status: 403, error: 'turn_provenance_stale' });

      // Step C: Subsequent inbound turn arrives, rotates capability and turnId to turn-2
      const nextTurnSession = buildSession({
        liveOrigin: { capability: CAPABILITY_B, turnId: 'turn-2', dispatchAttempt: 1 },
      });
      // Old capability A is rejected as stale
      expect(verifyReportRelay(nextTurnSession, CAPABILITY_A)).toEqual({
        ok: false,
        status: 403,
        error: 'origin_unproven',
      });
      // New capability B with turn-2 is authorized
      const nextTurnResult = verifyReportRelay(nextTurnSession, CAPABILITY_B);
      expect(nextTurnResult).toMatchObject({
        ok: true,
        source: { sessionId: 'worker-session', larkAppId: 'cli_worker' },
      });
    });
  });
});
