import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeCommand } from '../../../plugin/plugin.js';

// executeCommand reads the global PluginAPI SP injects at runtime; tests stub it directly.
//
// The timer cases dispatch the REAL NgRx actions ('[Task] SetCurrentTask' /
// '[Task] Toggle start'), both whitelisted in SP's ALLOWED_PLUGIN_ACTIONS, and
// read the live timer pointer from getAppState() (exposed by the flake SP
// patch). The old implementation wrote a Task.currentTimestamp field that no
// longer exists on the SP v19 model — time was never credited and phone-started
// timers were invisible. These tests pin the real-tracker behaviour.
declare global {
  // eslint-disable-next-line no-var
  var PluginAPI: {
    getTasks: ReturnType<typeof vi.fn>;
    getAppState: ReturnType<typeof vi.fn>;
    dispatchAction: ReturnType<typeof vi.fn>;
    addTask: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
  };
}

const task = (id: string, isDone = false) => ({
  id,
  title: `Task ${id}`,
  isDone,
  projectId: 'proj-1',
  parentId: null,
  tagIds: [],
  dueDay: null,
});

beforeEach(() => {
  globalThis.PluginAPI = {
    getTasks: vi.fn().mockResolvedValue([task('task-1'), task('task-2')]),
    getAppState: vi.fn().mockResolvedValue({ currentTaskId: null, tasks: {} }),
    dispatchAction: vi.fn(),
    addTask: vi.fn(),
    updateTask: vi.fn(),
  };
});

describe('executeCommand: startTask', () => {
  it('dispatches [Task] SetCurrentTask with the task id', async () => {
    const res = await executeCommand({ action: 'startTask', taskId: 'task-1' });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.dispatchAction).toHaveBeenCalledWith({
      type: '[Task] SetCurrentTask',
      id: 'task-1',
    });
    expect((res as { result: { started: boolean; taskId: string } }).result).toEqual({
      started: true,
      taskId: 'task-1',
    });
  });

  it('does NOT write any currentTimestamp ghost field', async () => {
    await executeCommand({ action: 'startTask', taskId: 'task-1' });
    const writes = globalThis.PluginAPI.updateTask.mock.calls.filter(
      ([, patch]) => patch && 'currentTimestamp' in (patch as Record<string, unknown>),
    );
    expect(writes).toHaveLength(0);
  });

  it('fails with a named error on an unknown task', async () => {
    const res = await executeCommand({ action: 'startTask', taskId: 'nope' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/Task not found: nope/);
    expect(globalThis.PluginAPI.dispatchAction).not.toHaveBeenCalled();
  });

  it('fails with a named error on a completed task', async () => {
    globalThis.PluginAPI.getTasks.mockResolvedValue([task('task-1', true)]);
    const res = await executeCommand({ action: 'startTask', taskId: 'task-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/completed/);
    expect(globalThis.PluginAPI.dispatchAction).not.toHaveBeenCalled();
  });

  it('returns a named error when dispatchAction is unavailable', async () => {
    delete (globalThis.PluginAPI as { dispatchAction?: unknown }).dispatchAction;
    const res = await executeCommand({ action: 'startTask', taskId: 'task-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/dispatchAction/);
  });
});

describe('executeCommand: stopTask', () => {
  it('dispatches [Task] Toggle start when a task is running', async () => {
    globalThis.PluginAPI.getAppState.mockResolvedValue({ currentTaskId: 'task-1', tasks: {} });
    const res = await executeCommand({ action: 'stopTask' });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.dispatchAction).toHaveBeenCalledWith({
      type: '[Task] Toggle start',
    });
    expect((res as { result: { stopped: boolean; taskId: string } }).result).toEqual({
      stopped: true,
      taskId: 'task-1',
    });
  });

  it('does NOT dispatch when nothing is running (anti auto-start guard)', async () => {
    // toggleStart with no current task STARTS the next task of today
    // (autoSetNextTask effect) — dispatching blindly would restart a timer.
    globalThis.PluginAPI.getAppState.mockResolvedValue({ currentTaskId: null, tasks: {} });
    const res = await executeCommand({ action: 'stopTask' });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.dispatchAction).not.toHaveBeenCalled();
    expect((res as { result: { stopped: boolean; taskId: string | null } }).result).toEqual({
      stopped: false,
      taskId: null,
    });
  });

  it('stops a task the plugin itself started on an unpatched build (memory fallback)', async () => {
    // getAppState without currentTaskId = SP build without the flake patch.
    globalThis.PluginAPI.getAppState.mockResolvedValue({ tasks: {} });
    await executeCommand({ action: 'startTask', taskId: 'task-2' });
    const res = await executeCommand({ action: 'stopTask' });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.dispatchAction).toHaveBeenCalledWith({
      type: '[Task] Toggle start',
    });
    expect((res as { result: { stopped: boolean; taskId: string } }).result).toEqual({
      stopped: true,
      taskId: 'task-2',
    });
  });

  it('returns a named error when dispatchAction is unavailable', async () => {
    globalThis.PluginAPI.getAppState.mockResolvedValue({ currentTaskId: 'task-1', tasks: {} });
    delete (globalThis.PluginAPI as { dispatchAction?: unknown }).dispatchAction;
    const res = await executeCommand({ action: 'stopTask' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/dispatchAction/);
  });
});

describe('executeCommand: loadCurrentTask', () => {
  it('returns the running task from the live timer pointer', async () => {
    globalThis.PluginAPI.getAppState.mockResolvedValue({ currentTaskId: 'task-1', tasks: {} });
    const res = await executeCommand({ action: 'loadCurrentTask' });
    expect(res.success).toBe(true);
    expect((res as { result: { id: string; title: string } }).result).toEqual({
      id: 'task-1',
      title: 'Task task-1',
      isDone: false,
      projectId: 'proj-1',
      parentId: null,
      tagIds: [],
      dueDay: null,
    });
  });

  it('returns null when no timer is running', async () => {
    const res = await executeCommand({ action: 'loadCurrentTask' });
    expect(res.success).toBe(true);
    expect((res as { result: unknown }).result).toBeNull();
  });

  it('falls back to plugin memory on an unpatched build', async () => {
    globalThis.PluginAPI.getAppState.mockResolvedValue({ tasks: {} });
    await executeCommand({ action: 'startTask', taskId: 'task-1' });
    const res = await executeCommand({ action: 'loadCurrentTask' });
    expect(res.success).toBe(true);
    expect((res as { result: { id: string } }).result).toMatchObject({ id: 'task-1' });
  });
});
