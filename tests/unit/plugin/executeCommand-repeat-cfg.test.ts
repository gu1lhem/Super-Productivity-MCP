import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeCommand } from '../../../plugin/plugin.js';

// executeCommand reads the global PluginAPI SP injects at runtime; tests stub it directly.
// The repeat-cfg methods only exist on SP builds carrying the typed plugin API
// (super-productivity#9798) — the plugin probes for them and returns a named
// error instead of a TypeError leaking out of the plugin sandbox.
declare global {
  // eslint-disable-next-line no-var
  var PluginAPI: {
    addTaskRepeatCfg?: ReturnType<typeof vi.fn>;
    updateTaskRepeatCfg?: ReturnType<typeof vi.fn>;
    deleteTaskRepeatCfg?: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  globalThis.PluginAPI = {
    addTaskRepeatCfg: vi.fn().mockResolvedValue('cfg-123'),
    updateTaskRepeatCfg: vi.fn().mockResolvedValue(undefined),
    deleteTaskRepeatCfg: vi.fn().mockResolvedValue(undefined),
  };
});

describe('executeCommand: addTaskRepeatCfg', () => {
  it('calls PluginAPI.addTaskRepeatCfg with taskId and the provided data', async () => {
    const res = await executeCommand({
      action: 'addTaskRepeatCfg',
      taskId: 'task-1',
      data: { repeatCycle: 'WEEKLY', repeatEvery: 2, monday: true },
    });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.addTaskRepeatCfg).toHaveBeenCalledWith('task-1', {
      repeatCycle: 'WEEKLY',
      repeatEvery: 2,
      monday: true,
    });
    expect((res as { result: unknown }).result).toBe('cfg-123');
  });

  it('defaults data to an empty object when absent', async () => {
    await executeCommand({ action: 'addTaskRepeatCfg', taskId: 'task-1' });
    expect(globalThis.PluginAPI.addTaskRepeatCfg).toHaveBeenCalledWith('task-1', {});
  });

  it('returns a named error on an SP build without the repeat-cfg plugin API', async () => {
    delete globalThis.PluginAPI.addTaskRepeatCfg;
    const res = await executeCommand({ action: 'addTaskRepeatCfg', taskId: 'task-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/PluginAPI\.addTaskRepeatCfg/);
    expect((res as { error: string }).error).toMatch(/SP PR #9798/);
  });

  it('surfaces an SP guard refusal as success=false with its message', async () => {
    globalThis.PluginAPI.addTaskRepeatCfg!.mockRejectedValueOnce(
      new Error('Task task-1 is already repeating'),
    );
    const res = await executeCommand({ action: 'addTaskRepeatCfg', taskId: 'task-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/already repeating/);
  });
});

describe('executeCommand: updateTaskRepeatCfg', () => {
  it('calls PluginAPI.updateTaskRepeatCfg with repeatCfgId and updates', async () => {
    const res = await executeCommand({
      action: 'updateTaskRepeatCfg',
      repeatCfgId: 'cfg-1',
      data: { isPaused: true },
    });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.updateTaskRepeatCfg).toHaveBeenCalledWith('cfg-1', { isPaused: true });
  });

  it('defaults data to an empty object when absent', async () => {
    await executeCommand({ action: 'updateTaskRepeatCfg', repeatCfgId: 'cfg-1' });
    expect(globalThis.PluginAPI.updateTaskRepeatCfg).toHaveBeenCalledWith('cfg-1', {});
  });

  it('returns a named error on an SP build without the repeat-cfg plugin API', async () => {
    delete globalThis.PluginAPI.updateTaskRepeatCfg;
    const res = await executeCommand({ action: 'updateTaskRepeatCfg', repeatCfgId: 'cfg-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/PluginAPI\.updateTaskRepeatCfg/);
  });
});

describe('executeCommand: deleteTaskRepeatCfg', () => {
  it('calls PluginAPI.deleteTaskRepeatCfg with repeatCfgId', async () => {
    const res = await executeCommand({ action: 'deleteTaskRepeatCfg', repeatCfgId: 'cfg-1' });
    expect(res.success).toBe(true);
    expect(globalThis.PluginAPI.deleteTaskRepeatCfg).toHaveBeenCalledWith('cfg-1');
  });

  it('returns a named error on an SP build without the repeat-cfg plugin API', async () => {
    delete globalThis.PluginAPI.deleteTaskRepeatCfg;
    const res = await executeCommand({ action: 'deleteTaskRepeatCfg', repeatCfgId: 'cfg-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/PluginAPI\.deleteTaskRepeatCfg/);
  });

  it('surfaces a permission refusal from SP', async () => {
    globalThis.PluginAPI.deleteTaskRepeatCfg!.mockRejectedValueOnce(
      new Error('Permission deleteTaskRepeatCfg not granted'),
    );
    const res = await executeCommand({ action: 'deleteTaskRepeatCfg', repeatCfgId: 'cfg-1' });
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/deleteTaskRepeatCfg/);
  });
});
