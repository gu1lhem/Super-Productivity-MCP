import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sendCommand before importing the module under test
vi.mock('../../../src/ipc/command-sender.js', () => ({
  sendCommand: vi.fn(),
}));

import { sendCommand } from '../../../src/ipc/command-sender.js';
import {
  createTaskRepeatCfgSchema,
  updateTaskRepeatCfgSchema,
  deleteTaskRepeatCfgSchema,
  REPEAT_WEEKDAYS,
  mapRepeatCfgData,
  validateRepeatCfgMerged,
  setsWeekdayOffWeeklyCycle,
  registerTaskTools,
} from '../../../src/tools/tasks.js';
import type { ResolvedDirs } from '../../../src/ipc/directories.js';
import type { Response } from '../../../src/ipc/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mockSend = vi.mocked(sendCommand);
const dirs: ResolvedDirs = { base: '/tmp/test', commands: '/tmp/test/pc', responses: '/tmp/test/pr' };

// Tool handlers are captured through a fake server so the real registered
// handlers are exercised (same pattern as tasks.test.ts).
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
const toolHandlers = new Map<string, ToolHandler>();
const fakeServer = {
  registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
    toolHandlers.set(name, handler);
  },
} as unknown as McpServer;
registerTaskTools(fakeServer, dirs);

function mockResponse(result: unknown): Response {
  return { success: true, result, timestamp: Date.now() };
}

beforeEach(() => vi.clearAllMocks());

describe('repeat cfg schemas', () => {
  it('create rejects an unknown parameter (strict)', () => {
    const res = createTaskRepeatCfgSchema.safeParse({ task_id: 't1', unknown_field: true });
    expect(res.success).toBe(false);
  });

  it('update rejects an unknown parameter (strict)', () => {
    const res = updateTaskRepeatCfgSchema.safeParse({ repeat_cfg_id: 'cfg-1', unknown_field: true });
    expect(res.success).toBe(false);
  });

  it('repeat_cycle only accepts the four SP literals', () => {
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_cycle: 'DAILY' }).success).toBe(true);
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_cycle: 'daily' }).success).toBe(false);
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_cycle: 'FORTNIGHTLY' }).success).toBe(false);
  });

  it('repeat_every is bounded to 1-1000', () => {
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_every: 1 }).success).toBe(true);
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_every: 1000 }).success).toBe(true);
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_every: 0 }).success).toBe(false);
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_every: 1001 }).success).toBe(false);
  });

  it('weekday flags are booleans on the wire', () => {
    const res = createTaskRepeatCfgSchema.safeParse({ task_id: 't1', repeat_cycle: 'WEEKLY', monday: true });
    expect(res.success).toBe(true);
    expect(createTaskRepeatCfgSchema.safeParse({ task_id: 't1', monday: 'yes' }).success).toBe(false);
  });

  it('delete takes only repeat_cfg_id', () => {
    expect(deleteTaskRepeatCfgSchema.safeParse({ repeat_cfg_id: 'cfg-1' }).success).toBe(true);
    expect(deleteTaskRepeatCfgSchema.safeParse({}).success).toBe(false);
  });
});

describe('mapRepeatCfgData', () => {
  it('maps snake_case wire fields to SP camelCase', () => {
    const out = mapRepeatCfgData({
      title: 'Standup',
      tag_ids: ['tag-1'],
      default_estimate: 60000,
      is_paused: true,
      repeat_cycle: 'WEEKLY',
      repeat_every: 2,
      start_date: '2026-11-02',
      start_time: '09:30',
      monday: true,
      monthly_week_of_month: -1,
      monthly_weekday: 3,
      monthly_last_day: false,
    });
    expect(out).toEqual({
      title: 'Standup',
      tagIds: ['tag-1'],
      defaultEstimate: 60000,
      isPaused: true,
      repeatCycle: 'WEEKLY',
      repeatEvery: 2,
      startDate: '2026-11-02',
      startTime: '09:30',
      monday: true,
      monthlyWeekOfMonth: -1,
      monthlyWeekday: 3,
      monthlyLastDay: false,
    });
  });

  it('only maps the provided fields (partial patch)', () => {
    const out = mapRepeatCfgData({ is_paused: true });
    expect(out).toEqual({ isPaused: true });
  });
});

describe('validateRepeatCfgMerged', () => {
  it('rejects a WEEKLY config with no weekday set', () => {
    expect(validateRepeatCfgMerged({ repeatCycle: 'WEEKLY' })).toMatch(/at least one weekday/);
  });

  it('accepts a WEEKLY config with a weekday set', () => {
    expect(validateRepeatCfgMerged({ repeatCycle: 'WEEKLY', monday: true })).toBeNull();
  });

  it('accepts non-WEEKLY cycles without weekdays', () => {
    expect(validateRepeatCfgMerged({ repeatCycle: 'DAILY' })).toBeNull();
    expect(validateRepeatCfgMerged({ repeatCycle: 'MONTHLY', monthlyWeekOfMonth: 1 })).toBeNull();
  });
});

describe('setsWeekdayOffWeeklyCycle', () => {
  it('flags weekday true on a non-WEEKLY cycle', () => {
    expect(setsWeekdayOffWeeklyCycle('DAILY', { monday: true })).toBe(true);
  });

  it('accepts weekdays on WEEKLY, and no-weekday patches elsewhere', () => {
    expect(setsWeekdayOffWeeklyCycle('WEEKLY', { monday: true })).toBe(false);
    expect(setsWeekdayOffWeeklyCycle('DAILY', { isPaused: true })).toBe(false);
  });

  it('checks all seven days', () => {
    for (const day of REPEAT_WEEKDAYS) {
      expect(setsWeekdayOffWeeklyCycle('MONTHLY', { [day]: true })).toBe(true);
    }
  });
});

describe('create_task_repeat_cfg handler', () => {
  it('sends addTaskRepeatCfg with the mapped patch', async () => {
    mockSend.mockResolvedValueOnce(mockResponse('cfg-123'));
    const res = (await toolHandlers.get('create_task_repeat_cfg')!({
      task_id: 't1',
      repeat_cycle: 'WEEKLY',
      repeat_every: 2,
      monday: true,
      wednesday: true,
    })) as Response;
    expect(res.success).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(dirs, 'addTaskRepeatCfg', {
      taskId: 't1',
      data: { repeatCycle: 'WEEKLY', repeatEvery: 2, monday: true, wednesday: true },
    });
  });

  it('rejects a WEEKLY config with no weekday before any command is sent', async () => {
    const res = (await toolHandlers.get('create_task_repeat_cfg')!({
      task_id: 't1',
      repeat_cycle: 'WEEKLY',
    })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/at least one weekday/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects weekday flags on a non-WEEKLY cycle', async () => {
    const res = (await toolHandlers.get('create_task_repeat_cfg')!({
      task_id: 't1',
      repeat_cycle: 'DAILY',
      monday: true,
    })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/WEEKLY cycle/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('requires task_id', async () => {
    const res = (await toolHandlers.get('create_task_repeat_cfg')!({})) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/task_id is required/);
  });

  it('surfaces a plugin refusal (e.g. already repeating) as success=false', async () => {
    mockSend.mockResolvedValueOnce({ success: false, error: 'Task t1 is already repeating', timestamp: Date.now() });
    const res = (await toolHandlers.get('create_task_repeat_cfg')!({ task_id: 't1' })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/already repeating/);
  });
});

describe('update_task_repeat_cfg handler', () => {
  const existing = { id: 'cfg-1', title: 'Zippy', repeatCycle: 'WEEKLY', monday: true };

  it('validates against the merged cfg and sends only the patch', async () => {
    mockSend
      .mockResolvedValueOnce(mockResponse([existing]))
      .mockResolvedValueOnce(mockResponse(null));
    const res = (await toolHandlers.get('update_task_repeat_cfg')!({
      repeat_cfg_id: 'cfg-1',
      is_paused: true,
    })) as Response;
    expect(res.success).toBe(true);
    expect(mockSend).toHaveBeenLastCalledWith(dirs, 'updateTaskRepeatCfg', {
      repeatCfgId: 'cfg-1',
      data: { isPaused: true },
    });
  });

  it('rejects a patch that would strip the last weekday of a WEEKLY cfg', async () => {
    mockSend.mockResolvedValueOnce(mockResponse([existing]));
    const res = (await toolHandlers.get('update_task_repeat_cfg')!({
      repeat_cfg_id: 'cfg-1',
      monday: false,
    })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/at least one weekday/);
    expect(mockSend).not.toHaveBeenCalledWith(dirs, 'updateTaskRepeatCfg', expect.anything());
  });

  it('rejects switching to WEEKLY without keeping a weekday', async () => {
    const daily = { id: 'cfg-2', repeatCycle: 'DAILY' };
    mockSend.mockResolvedValueOnce(mockResponse([daily]));
    const res = (await toolHandlers.get('update_task_repeat_cfg')!({
      repeat_cfg_id: 'cfg-2',
      repeat_cycle: 'WEEKLY',
    })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/at least one weekday/);
  });

  it('fails on an unknown repeat_cfg_id', async () => {
    mockSend.mockResolvedValueOnce(mockResponse([]));
    const res = (await toolHandlers.get('update_task_repeat_cfg')!({
      repeat_cfg_id: 'nope',
    })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/not found/i);
  });
});

describe('delete_task_repeat_cfg handler', () => {
  it('sends deleteTaskRepeatCfg with the id', async () => {
    mockSend.mockResolvedValueOnce(mockResponse(null));
    const res = (await toolHandlers.get('delete_task_repeat_cfg')!({
      repeat_cfg_id: 'cfg-1',
    })) as Response;
    expect(res.success).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(dirs, 'deleteTaskRepeatCfg', { repeatCfgId: 'cfg-1' });
  });

  it('requires repeat_cfg_id', async () => {
    const res = (await toolHandlers.get('delete_task_repeat_cfg')!({})) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/repeat_cfg_id is required/);
  });

  it('surfaces a permission refusal from SP', async () => {
    mockSend.mockResolvedValueOnce({ success: false, error: 'Permission deleteTaskRepeatCfg not granted', timestamp: Date.now() });
    const res = (await toolHandlers.get('delete_task_repeat_cfg')!({ repeat_cfg_id: 'cfg-1' })) as Response;
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toMatch(/deleteTaskRepeatCfg/);
  });
});
