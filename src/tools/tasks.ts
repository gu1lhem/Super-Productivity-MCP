import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedDirs } from '../ipc/directories.js';
import { sendCommand } from '../ipc/command-sender.js';
import type { TaskFilters } from '../ipc/types.js';
import { errorResult, okResult } from './result.js';
import { parseDuration } from './duration.js';

interface TaskRecord {
  id: string;
  title: string;
  isDone: boolean;
  projectId: string | null;
  parentId?: string | null;
  tagIds: string[];
  notes?: string;
  dueDay?: string | null;
  dueWithTime?: number | null;
  plannedAt?: number | null;
  timeSpentOnDay?: Record<string, number>;
  timeEstimate: number;
  timeSpent: number;
  doneOn?: number | null;
  repeatCfgId?: string | null;
  [key: string]: unknown;
}



/** Compute local YYYY-MM-DD date string (not UTC — spec requires local timezone boundary). */
export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Apply triage filters to a task list. Exported for testability. */
export function applyTriageFilters(
  tasks: TaskRecord[],
  opts: { parentsOnly?: boolean; overdue?: boolean; unscheduled?: boolean; plannedForToday?: boolean },
): TaskRecord[] {
  let result = tasks;
  if (opts.parentsOnly) result = result.filter(t => !t.parentId);
  if (opts.overdue) {
    const today = localDateStr();
    result = result.filter(t => t.dueDay != null && (t.dueDay as string) < today);
  }
  if (opts.unscheduled) result = result.filter(t => !t.dueDay && !t.dueWithTime);
  if (opts.plannedForToday) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfTomorrow = startOfToday + 86_400_000;
    result = result.filter(t => {
      const p = t.plannedAt;
      return p != null && p >= startOfToday && p < startOfTomorrow;
    });
  }
  return result;
}

// Every tool schema below is wrapped in `.strict()` so a call with an unrecognized
// parameter fails validation instead of silently stripping it — issue #101 found
// this could look like a successful call ("update_task" with a typo'd field name)
// that silently wrote nothing. Nested array-item schemas (bulk_update_tasks'
// `updates[]`, create_task's `subtasks[]`) get the same treatment for the same reason.

// Shared by every tool that writes a task priority (issue #138). Numbers only — SP also
// reads 'high'/'medium'/'low' strings, but one representation keeps the contract testable.
const prioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional()
  .describe('Task priority: 1 = Low, 2 = Medium, 3 = High. Pass null to clear. Omit to leave unchanged.');

const createTaskShape = {
  title: z.string().describe('Task title. May include SP short syntax: #tag +project @due-date 30m'),
  notes: z.string().optional().describe('Task notes/description'),
  project_id: z.string().optional().describe('Project ID to assign task to'),
  parent_id: z.string().optional().describe('Parent task ID for creating subtasks'),
  tag_ids: z.array(z.string()).optional().describe('Tag IDs to assign'),
  deadline_day: z.string().optional().describe('Deadline date in ISO format (e.g. 2026-04-20). Independent from due_day/planned_at.'),
  priority: prioritySchema,
};
export const createTaskSchema = z.object(createTaskShape).strict();

const getTasksShape = {
  project_id: z.string().optional().describe('Filter by project ID'),
  tag_id: z.string().optional().describe('Filter by tag ID'),
  include_done: z.boolean().optional().default(false).describe('Include completed tasks'),
  include_archived: z.boolean().optional().default(false).describe('Include archived tasks'),
  search_query: z.string().optional().describe('Case-insensitive title search'),
  parents_only: z.boolean().optional().default(false).describe('Exclude subtasks — return only top-level tasks'),
  overdue: z.boolean().optional().default(false).describe('Return only tasks with a due date strictly before today'),
  unscheduled: z.boolean().optional().default(false).describe('Return only tasks with no due date and no scheduled time'),
  planned_for_today: z.boolean().optional().default(false).describe('Return only tasks planned for today (via plannedAt timestamp)'),
  recurring_only: z.boolean().optional().default(false).describe('Return only recurring tasks (those with a repeatCfgId)'),
  fields: z.array(z.string()).optional().describe('Return only these fields per task (e.g. ["id", "title", "dueDay"]). Omit for full objects.'),
};
export const getTasksSchema = z.object(getTasksShape).strict();

const updateTaskShape = {
  task_id: z.string().describe('Task ID to update'),
  title: z.string().optional().describe('New title (may include SP short syntax)'),
  notes: z.string().optional().describe('New notes'),
  is_done: z.boolean().optional().describe('Mark as done/undone'),
  due_day: z.string().optional().describe('Due date in ISO format (e.g. 2026-04-20), or empty string to clear'),
  deadline_day: z.string().optional().describe('Deadline date in ISO format (e.g. 2026-04-20), or empty string to clear. Independent from due_day/planned_at.'),
  priority: prioritySchema,
  planned_at: z.number().nullable().optional().describe('Unix ms timestamp to plan task for a specific time (e.g. start of today = plan for today). Pass null to unplan. Independent from due_day.'),
  due_with_time: z.number().int().positive().nullable().optional().describe('Unix ms timestamp to schedule the task at a specific time (SP "dueWithTime"). Clears dueDay — SP keeps the two mutually exclusive — so it cannot be combined with due_day. Pass null to clear. Does not notify on its own; set remind_at for that.'),
  remind_at: z.number().int().positive().optional().describe('Unix ms timestamp at which SP fires a reminder notification for the task (SP "remindAt"), usually equal to or shortly before due_with_time. Clearing is not supported: SP\'s plugin API rejects a null remindAt.'),
  time_estimate: z.number().optional().describe('Time estimate in milliseconds'),
  tag_ids: z.array(z.string()).optional().describe('Bulk-replace all tags with this list (FR-003)'),
};
export const updateTaskSchema = z.object(updateTaskShape).strict();

const completeTaskShape = {
  task_id: z.string().describe('Task ID to complete'),
};
export const completeTaskSchema = z.object(completeTaskShape).strict();

const addTagToTaskShape = {
  task_id: z.string().describe('Task ID'),
  tag_id: z.string().describe('Tag ID to add'),
};
export const addTagToTaskSchema = z.object(addTagToTaskShape).strict();

const removeTagFromTaskShape = {
  task_id: z.string().describe('Task ID'),
  tag_id: z.string().describe('Tag ID to remove'),
};
export const removeTagFromTaskSchema = z.object(removeTagFromTaskShape).strict();

const getCurrentTaskShape = {};
export const getCurrentTaskSchema = z.object(getCurrentTaskShape).strict();

const startTaskShape = {
  task_id: z.string().describe('Task ID to start tracking'),
};
export const startTaskSchema = z.object(startTaskShape).strict();

const stopTaskShape = {};
export const stopTaskSchema = z.object(stopTaskShape).strict();

const bulkCompleteTasksShape = {
  task_ids: z.array(z.string()).max(100).describe('Array of task IDs to complete'),
};
export const bulkCompleteTasksSchema = z.object(bulkCompleteTasksShape).strict();

const bulkUpdateTaskItemShape = {
  task_id: z.string().describe('Task ID to update'),
  title: z.string().optional().describe('New title'),
  notes: z.string().optional().describe('New notes'),
  due_day: z.string().optional().describe('Due date (YYYY-MM-DD) or empty string to clear'),
  deadline_day: z.string().optional().describe('Deadline date (YYYY-MM-DD) or empty string to clear'),
  priority: prioritySchema,
  tag_ids: z.array(z.string()).optional().describe('Replace all tags'),
  time_estimate: z.number().optional().describe('Time estimate in ms'),
};
export const bulkUpdateTaskItemSchema = z.object(bulkUpdateTaskItemShape).strict();
const bulkUpdateTasksShape = {
  updates: z.array(bulkUpdateTaskItemSchema).max(100).describe('Array of task updates'),
};
export const bulkUpdateTasksSchema = z.object(bulkUpdateTasksShape).strict();

const moveTaskToProjectShape = {
  task_id: z.string().describe('Task ID to move'),
  project_id: z.string().describe('Destination project ID'),
};
export const moveTaskToProjectSchema = z.object(moveTaskToProjectShape).strict();

const moveTasksBacklogShape = {
  task_ids: z.array(z.string()).min(1).max(100).describe('IDs of top-level tasks to move (1-100)'),
  destination: z.enum(['backlog', 'regular']).describe('"backlog" moves tasks into their project\'s backlog; "regular" moves them back to the regular list'),
};
export const moveTasksBacklogSchema = z.object(moveTasksBacklogShape).strict();

const reorderTasksShape = {
  task_ids: z.array(z.string()).describe('Complete ordered list of task IDs'),
  context_id: z.string().describe('Project ID (if context_type is "project") or parent task ID (if "parent")'),
  context_type: z.enum(['project', 'parent']).describe('Whether context_id refers to a project or a parent task'),
};
export const reorderTasksSchema = z.object(reorderTasksShape).strict();

const deleteTaskShape = {
  task_id: z.string().describe('Task ID to delete'),
};
export const deleteTaskSchema = z.object(deleteTaskShape).strict();

const subtaskItemSchema = z.object({
  title: z.string().describe('Subtask title'),
  notes: z.string().optional().describe('Subtask notes'),
  priority: prioritySchema,
}).strict();
const createTaskWithSubtasksShape = {
  title: z.string().describe('Parent task title'),
  notes: z.string().optional().describe('Parent task notes'),
  project_id: z.string().optional().describe('Project ID for the parent task'),
  tag_ids: z.array(z.string()).optional().describe('Tag IDs for the parent task'),
  priority: prioritySchema,
  subtasks: z.array(subtaskItemSchema).describe('Subtask definitions'),
};
export const createTaskWithSubtasksSchema = z.object(createTaskWithSubtasksShape).strict();

const planTasksForTodayShape = {
  task_ids: z.array(z.string()).max(100).describe('Task IDs to plan/unplan'),
  unplan: z.boolean().optional().default(false).describe('If true, removes tasks from today instead of planning them'),
};
export const planTasksForTodaySchema = z.object(planTasksForTodayShape).strict();

const getWorklogShape = {
  start_date: z.string().describe('Start date (ISO format, e.g. 2026-04-14)'),
  end_date: z.string().describe('End date (ISO format, e.g. 2026-04-20)'),
};
export const getWorklogSchema = z.object(getWorklogShape).strict();

const worklogEntryShape = {
  date: z.string().describe('Day to log against (ISO format, e.g. 2026-08-31)'),
  duration: z.string().describe('Duration in SP short syntax: 2h, 45m, 1h30m, 90s'),
};
export const worklogEntrySchema = z.object(worklogEntryShape).strict();

const logTimeShape = {
  task_id: z.string().describe('Task ID to log time against'),
  duration: z.string().optional().describe('Duration in SP short syntax: 2h, 45m, 1h30m, 90s. Single-day form — mutually exclusive with entries.'),
  date: z.string().optional().describe('Day to log against (ISO format, e.g. 2026-08-31). Defaults to today. Only meaningful alongside duration.'),
  entries: z.array(worklogEntrySchema).max(100).optional().describe('Log several days in one call, e.g. backfilling a week. Each entry needs its own date. Mutually exclusive with duration.'),
  mode: z.enum(['add', 'set']).optional().default('add').describe('"add" increments each day\'s tracked time; "set" overwrites it — pass 0m with "set" to clear a day. Applies to every entry.'),
};
export const logTimeSchema = z.object(logTimeShape).strict();

const getTaskRepeatCfgsShape = {};
export const getTaskRepeatCfgsSchema = z.object(getTaskRepeatCfgsShape).strict();

// ─── Task repeat cfg management (SP PR #9798) ────────────────────────────────
//
// SP's model: a repeat cfg is always attached to an existing task (the task
// holds repeatCfgId, the cfg holds the template the next instances are
// generated from). So "create" takes a task_id, and every write goes through
// PluginAPI.addTaskRepeatCfg / updateTaskRepeatCfg / deleteTaskRepeatCfg —
// typed methods that run the same validation, effects and op-log entries as
// the schedule dialog. The plugin probes for them at runtime and returns a
// clear error on SP builds that predate the patch.

const repeatCycleSchema = z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** Days the WEEKLY cycle reads. Field names are identical in SP's model. */
export const REPEAT_WEEKDAYS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;
export type RepeatWeekday = (typeof REPEAT_WEEKDAYS)[number];

// Shared shape for create_task_repeat_cfg (minus task_id) and
// update_task_repeat_cfg (minus repeat_cfg_id). Snake_case on the wire,
// mapped to SP's camelCase before the command is sent.
const taskRepeatCfgDataShape = {
  title: z.string().nullable().optional().describe('Title for the generated tasks. Defaults to the source task\'s title. Pass null to clear (update only).'),
  notes: z.string().nullable().optional().describe('Notes for the generated tasks. Pass null to clear (update only).'),
  tag_ids: z.array(z.string()).optional().describe('Tag IDs for the generated tasks'),
  default_estimate: z.number().optional().describe('Time estimate in milliseconds for the generated tasks'),
  is_paused: z.boolean().optional().describe('Pause the recurrence — no new instances are created while paused'),
  repeat_cycle: repeatCycleSchema.optional().describe('Repeat cycle. Defaults to DAILY.'),
  repeat_every: z.number().int().min(1).max(1000).optional().describe('Every nth day/week/month/year (1-1000). Defaults to 1.'),
  start_date: z.string().optional().describe('ISO date (YYYY-MM-DD) the recurrence counts from. Defaults to the task\'s due day, or today.'),
  start_time: z.string().optional().describe('Time of day as HH:mm — instances are then scheduled with a reminder using the reminder offset from global config'),
  ...Object.fromEntries(REPEAT_WEEKDAYS.map(day => [day, z.boolean().optional().describe(`WEEKLY only: repeat on ${day}s. Setting any weekday true on another cycle is rejected.`)])),
  monthly_week_of_month: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]).optional().describe('MONTHLY only: 1-4 = first through fourth occurrence of the weekday, -1 = last'),
  monthly_weekday: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional().describe('MONTHLY only: 0 = Sunday … 6 = Saturday (pairs with monthly_week_of_month)'),
  monthly_last_day: z.boolean().optional().describe('MONTHLY only: anchor to the last calendar day of every month'),
} as Record<string, z.ZodTypeAny>;

const createTaskRepeatCfgShape = {
  task_id: z.string().describe('ID of the existing top-level task to make recurring (cannot be a subtask, an issue task, or already repeating)'),
  ...taskRepeatCfgDataShape,
};
export const createTaskRepeatCfgSchema = z.object(createTaskRepeatCfgShape).strict();

const updateTaskRepeatCfgShape = {
  repeat_cfg_id: z.string().describe('Repeat config ID to update'),
  ...taskRepeatCfgDataShape,
};
export const updateTaskRepeatCfgSchema = z.object(updateTaskRepeatCfgShape).strict();

const deleteTaskRepeatCfgShape = {
  repeat_cfg_id: z.string().describe('Repeat config ID to delete. Tasks it already created stay, but stop repeating.'),
};
export const deleteTaskRepeatCfgSchema = z.object(deleteTaskRepeatCfgShape).strict();

/** Map the wire (snake_case) fields onto SP's PluginTaskRepeatCfgData (camelCase). */
export function mapRepeatCfgData(
  input: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.notes !== undefined) out.notes = input.notes;
  if (input.tag_ids !== undefined) out.tagIds = input.tag_ids;
  if (input.default_estimate !== undefined) out.defaultEstimate = input.default_estimate;
  if (input.is_paused !== undefined) out.isPaused = input.is_paused;
  if (input.repeat_cycle !== undefined) out.repeatCycle = input.repeat_cycle;
  if (input.repeat_every !== undefined) out.repeatEvery = input.repeat_every;
  if (input.start_date !== undefined) out.startDate = input.start_date;
  if (input.start_time !== undefined) out.startTime = input.start_time;
  for (const day of REPEAT_WEEKDAYS) {
    if (input[day] !== undefined) out[day] = input[day];
  }
  if (input.monthly_week_of_month !== undefined) out.monthlyWeekOfMonth = input.monthly_week_of_month;
  if (input.monthly_weekday !== undefined) out.monthlyWeekday = input.monthly_weekday;
  if (input.monthly_last_day !== undefined) out.monthlyLastDay = input.monthly_last_day;
  return out;
}

/**
 * Coherence checks mirroring the SP bridge's own guards (super-productivity#9798),
 * applied server-side so a bad payload fails with a named reason instead of a
 * 2s poll round-trip first. Returns an error message, or null when coherent.
 */
export function validateRepeatCfgMerged(merged: {
  repeatCycle?: string;
} & Partial<Record<RepeatWeekday, unknown>>): string | null {
  if (merged.repeatCycle === 'WEEKLY' && !REPEAT_WEEKDAYS.some(day => merged[day] === true)) {
    return 'A WEEKLY repeat config needs at least one weekday set to true (monday…sunday) — otherwise it never produces an occurrence';
  }
  return null;
}

/** True when the patch flags a weekday true on a non-WEEKLY (effective) cycle. */
export function setsWeekdayOffWeeklyCycle(
  repeatCycle: string | undefined,
  patch: Partial<Record<RepeatWeekday, unknown>>,
): boolean {
  return repeatCycle !== 'WEEKLY' && REPEAT_WEEKDAYS.some(day => patch[day] === true);
}

export function registerTaskTools(server: McpServer, dirs: ResolvedDirs): void {
  // create_task
  server.registerTool(
    'create_task',
    {
      description: 'Create a new task in Super Productivity. Supports SP short syntax in the title: #tag, +project (prefix match, min 3 chars), @due-date (e.g. @tomorrow, @friday 3pm), and time estimates (30m, 1h, 1h/2h for spent/estimate). Tasks without a project go to the Inbox.',
      inputSchema: createTaskSchema,
    },
    async ({ title, notes, project_id, parent_id, tag_ids, deadline_day, priority }) => {
      if (!title?.trim()) return errorResult('Title is required');

      const data: Record<string, unknown> = { title, notes: notes ?? '', tagIds: tag_ids ?? [] };
      if (project_id) data.projectId = project_id;
      if (parent_id) data.parentId = parent_id;
      if (deadline_day !== undefined) data.deadlineDay = deadline_day || null;
      // null on create means 'no priority', which is already the default — send nothing.
      if (priority != null) data.priority = priority;

      // SP auto-assigns plannedAt/dueDay to today when viewing Today context.
      // Passing null satisfies SP's `'dueDay' in additional` guard, preventing auto-scheduling
      // unless the title contains @date syntax (which SP will parse into a date itself).
      const hasDateSyntax = /@/.test(title);
      if (!hasDateSyntax) {
        data.plannedAt = null;
        data.dueDay = null;
      }

      // T016: subtask SP syntax workaround
      const hasSyntax = parent_id && /[@#+]/.test(title);
      if (hasSyntax) {
        data.title = title.replace(/\s*[@#+]\S+/g, '').trim() || title;
      }

      const res = await sendCommand(dirs, 'addTask', { data });
      if (!res.success) return errorResult(res.error ?? 'Failed to create task');

      // Step 2 of workaround: update with original title to trigger syntax parsing
      if (hasSyntax && res.result) {
        await sendCommand(dirs, 'updateTask', { taskId: res.result as string, data: { title } });
      }

      return okResult({ taskId: res.result });
    },
  );

  // get_tasks
  server.registerTool(
    'get_tasks',
    {
      description: 'Get tasks from Super Productivity with optional filters. By default returns non-done, non-archived tasks.',
      inputSchema: getTasksSchema,
    },
    async ({ project_id, tag_id, include_done, include_archived, search_query, parents_only, overdue, unscheduled, planned_for_today, recurring_only, fields }) => {
      const filters: TaskFilters = {
        projectId: project_id,
        tagId: tag_id,
        includeDone: include_done,
        includeArchived: include_archived,
        searchQuery: search_query,
      };
      const res = await sendCommand(dirs, 'getTasks', { filters });
      if (!res.success) return errorResult(res.error ?? 'Failed to get tasks');

      // Server-side filtering
      let tasks = (res.result as TaskRecord[]) ?? [];
      if (!include_done) tasks = tasks.filter(t => !t.isDone);
      if (project_id) tasks = tasks.filter(t => t.projectId === project_id);
      if (tag_id) tasks = tasks.filter(t => t.tagIds?.includes(tag_id));
      if (search_query) {
        const q = search_query.toLowerCase();
        tasks = tasks.filter(t => t.title?.toLowerCase().includes(q) || (t.notes && t.notes.toLowerCase().includes(q)));
      }
      if (recurring_only) tasks = tasks.filter(t => t.repeatCfgId != null);

      // Triage filters (FR-004, FR-005, FR-006)
      tasks = applyTriageFilters(tasks, { parentsOnly: parents_only, overdue, unscheduled, plannedForToday: planned_for_today });

      // Field selection (005-FR-001)
      if (fields && fields.length > 0) {
        const shaped = tasks.map(t => {
          const obj: Record<string, unknown> = {};
          for (const f of fields) { if (f in t) obj[f] = (t as Record<string, unknown>)[f]; }
          return obj;
        });
        return okResult(shaped);
      }

      return okResult(tasks);
    },
  );

  // update_task
  server.registerTool(
    'update_task',
    {
      description: 'Update an existing task. Supports SP short syntax in the title. Time spent is not settable here — SP derives it from the per-day worklog, so use log_time.',
      inputSchema: updateTaskSchema,
    },
    async ({ task_id, title, notes, is_done, due_day, deadline_day, priority, planned_at, due_with_time, remind_at, time_estimate, tag_ids }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (due_with_time != null && due_day) {
        return errorResult('due_day and due_with_time are mutually exclusive — pass only one');
      }

      const data: Record<string, unknown> = {};
      if (title !== undefined) data.title = title;
      if (notes !== undefined) data.notes = notes;
      if (is_done !== undefined) {
        data.isDone = is_done;
        data.doneOn = is_done ? Date.now() : null;
      }
      if (due_day !== undefined) {
        data.dueDay = due_day || null;
        // Same mutual exclusivity SP's own scheduleTaskWithTime reducer enforces, applied
        // in this direction too: setting a plain due_day on a task that already carries a
        // timed dueWithTime must clear it, or the task would end up with both set — a state
        // SP's own reducer never produces. Only clears when due_with_time wasn't itself
        // passed in this same call; that case is handled below instead.
        if (due_day && due_with_time === undefined) data.dueWithTime = null;
      }
      if (deadline_day !== undefined) data.deadlineDay = deadline_day || null;
      if (priority !== undefined) data.priority = priority;
      if (planned_at !== undefined) data.plannedAt = planned_at;
      // Same mutual exclusivity SP's own scheduleTaskWithTime reducer enforces:
      // setting dueWithTime clears dueDay.
      if (due_with_time !== undefined) {
        data.dueWithTime = due_with_time;
        if (due_with_time !== null) data.dueDay = null;
      }
      // SP's reminder selector picks up any non-done task with a numeric remindAt.
      if (remind_at !== undefined) data.remindAt = remind_at;
      if (time_estimate !== undefined) data.timeEstimate = time_estimate;
      // tag_ids replaces the entire tag list; use add_tag_to_task / remove_tag_from_task for incremental changes
      if (tag_ids !== undefined) data.tagIds = tag_ids;

      const res = await sendCommand(dirs, 'updateTask', { taskId: task_id, data });
      if (!res.success) return errorResult(res.error ?? 'Failed to update task');
      return okResult(res.result);
    },
  );

  // complete_task
  server.registerTool(
    'complete_task',
    {
      description: 'Mark a task as complete in Super Productivity.',
      inputSchema: completeTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'setTaskDone', { taskId: task_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to complete task');
      return okResult(res.result);
    },
  );

  // T004: add_tag_to_task (FR-001 — add single tag without replacing others)
  server.registerTool(
    'add_tag_to_task',
    {
      description: 'Add a single tag to a task without modifying its other existing tags. Idempotent: calling with an already-present tag succeeds silently.',
      inputSchema: addTagToTaskSchema,
    },
    async ({ task_id, tag_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (!tag_id?.trim()) return errorResult('tag_id is required');
      const res = await sendCommand(dirs, 'addTagToTask', { taskId: task_id, tagId: tag_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to add tag');
      return okResult({ success: true });
    },
  );

  // T005: remove_tag_from_task (FR-002 — remove single tag; error if not present)
  server.registerTool(
    'remove_tag_from_task',
    {
      description: 'Remove a single tag from a task without modifying its other existing tags. Returns an error if the tag is not currently on the task.',
      inputSchema: removeTagFromTaskSchema,
    },
    async ({ task_id, tag_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (!tag_id?.trim()) return errorResult('tag_id is required');
      const res = await sendCommand(dirs, 'removeTagFromTask', { taskId: task_id, tagId: tag_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to remove tag');
      return okResult({ success: true });
    },
  );

  // T014: get_current_task (FR-010 — return currently time-tracked task or null)
  server.registerTool(
    'get_current_task',
    {
      description: 'Get the currently time-tracked task in Super Productivity. Returns { task: null } when no task has an active timer.',
      inputSchema: getCurrentTaskSchema,
    },
    async () => {
      const res = await sendCommand(dirs, 'loadCurrentTask', {});
      if (!res.success) return errorResult(res.error ?? 'Failed to get current task');
      return okResult({ task: res.result ?? null });
    },
  );

  // start_task (003-FR-001 — start time tracker on a task)
  server.registerTool(
    'start_task',
    {
      description: 'Start the time tracker on a task — the real SP tracker, so time is credited and synced like from the app. If another task is being tracked, SP switches the timer to this task automatically. Cannot start tracking a completed task.',
      inputSchema: startTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'startTask', { taskId: task_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to start task');
      return okResult(res.result ?? { started: true, taskId: task_id });
    },
  );

  // stop_task (003-FR-002 — stop the currently running timer)
  server.registerTool(
    'stop_task',
    {
      description: 'Stop the currently running time tracker — including timers started from other devices. Idempotent: reports stopped=false when nothing was running instead of failing.',
      inputSchema: stopTaskSchema,
    },
    async () => {
      const res = await sendCommand(dirs, 'stopTask', {});
      if (!res.success) return errorResult(res.error ?? 'Failed to stop task');
      return okResult(res.result ?? { stopped: false, taskId: null });
    },
  );

  // bulk_complete_tasks (003-FR-008 — mark multiple tasks done in one round-trip)
  server.registerTool(
    'bulk_complete_tasks',
    {
      description: 'Mark multiple tasks as complete in a single operation. Uses partial-success semantics: each task reports its own success/error.',
      inputSchema: bulkCompleteTasksSchema,
    },
    async ({ task_ids }) => {
      const res = await sendCommand(dirs, 'bulkCompleteTasks', { taskIds: task_ids ?? [] });
      if (!res.success) return errorResult(res.error ?? 'Failed to bulk complete tasks');
      return okResult(res.result);
    },
  );

  // bulk_update_tasks (003-FR-009 — apply different updates to multiple tasks)
  server.registerTool(
    'bulk_update_tasks',
    {
      description: 'Update multiple tasks in a single operation. Each item specifies a task_id and the fields to update. Uses partial-success semantics. Time spent is not settable here — SP derives it from the per-day worklog, so use log_time.',
      inputSchema: bulkUpdateTasksSchema,
    },
    async ({ updates }) => {
      const mapped = (updates ?? []).map(u => ({
        taskId: u.task_id,
        data: {
          ...(u.title !== undefined && { title: u.title }),
          ...(u.notes !== undefined && { notes: u.notes }),
          ...(u.due_day !== undefined && { dueDay: u.due_day || null }),
          ...(u.deadline_day !== undefined && { deadlineDay: u.deadline_day || null }),
          ...(u.priority !== undefined && { priority: u.priority }),
          ...(u.tag_ids !== undefined && { tagIds: u.tag_ids }),
          ...(u.time_estimate !== undefined && { timeEstimate: u.time_estimate }),
        },
      }));
      const res = await sendCommand(dirs, 'bulkUpdateTasks', { updates: mapped });
      if (!res.success) return errorResult(res.error ?? 'Failed to bulk update tasks');
      return okResult(res.result);
    },
  );

  // move_task_to_project (FR-008 — move top-level task; error on subtask)
  server.registerTool(
    'move_task_to_project',
    {
      description: 'Move a top-level task to a different project. Returns an error if called on a subtask.',
      inputSchema: moveTaskToProjectSchema,
    },
    async ({ task_id, project_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (!project_id?.trim()) return errorResult('project_id is required');
      const res = await sendCommand(dirs, 'moveTaskToProject', { taskId: task_id, projectId: project_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to move task');
      return okResult({ success: true });
    },
  );

  // move_tasks_backlog — move top-level tasks between a project's regular list and backlog
  server.registerTool(
    'move_tasks_backlog',
    {
      description: 'Move top-level tasks between their project\'s regular list and its backlog (1-100 task_ids, destination "backlog" or "regular"). Tasks are appended to the destination list in the given order. The whole batch is validated first; moving into the backlog of a project with the backlog disabled (e.g. Inbox) is refused. Returns { moved, unchanged }.',
      inputSchema: moveTasksBacklogSchema,
    },
    async ({ task_ids, destination }) => {
      if (!task_ids?.length) return errorResult('task_ids must not be empty');
      const res = await sendCommand(dirs, 'moveTasksBacklog', { taskIds: task_ids, destination });
      if (!res.success) return errorResult(res.error ?? 'Failed to move tasks');
      return okResult(res.result);
    },
  );

  // reorder_tasks (FR-009 — reorder tasks within a project or parent)
  server.registerTool(
    'reorder_tasks',
    {
      description: 'Reorder tasks within a project or subtasks within a parent task. Provide a complete ordered list of task IDs — partial reordering is not supported. Backlog tasks are rejected; use move_tasks_backlog first.',
      inputSchema: reorderTasksSchema,
    },
    async ({ task_ids, context_id, context_type }) => {
      if (!task_ids?.length) return errorResult('task_ids must not be empty');
      if (!context_id?.trim()) return errorResult('context_id is required');
      const res = await sendCommand(dirs, 'reorderTasks', { taskIds: task_ids, contextId: context_id, contextType: context_type });
      if (!res.success) return errorResult(res.error ?? 'Failed to reorder tasks');
      return okResult({ success: true });
    },
  );

  // delete_task (005-FR-005)
  server.registerTool(
    'delete_task',
    {
      description: 'Permanently delete a task. Deleting a parent also removes all subtasks.',
      inputSchema: deleteTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'deleteTask', { taskId: task_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to delete task');
      return okResult({ success: true });
    },
  );

  // create_task_with_subtasks (005-FR-008)
  server.registerTool(
    'create_task_with_subtasks',
    {
      description: 'Create a parent task with subtasks in one operation. Returns parentId and subtaskIds.',
      inputSchema: createTaskWithSubtasksSchema,
    },
    async ({ title, notes, project_id, tag_ids, priority, subtasks }) => {
      if (!title?.trim()) return errorResult('Title is required');
      const data: Record<string, unknown> = {
        title,
        notes: notes ?? '',
        projectId: project_id,
        tagIds: tag_ids ?? [],
        subtasks: subtasks ?? [],
      };
      if (priority != null) data.priority = priority;
      const res = await sendCommand(dirs, 'createTaskWithSubtasks', { data });
      if (!res.success) return errorResult(res.error ?? 'Failed to create task with subtasks');
      return okResult(res.result);
    },
  );

  // plan_tasks_for_today (006-FR-004)
  server.registerTool(
    'plan_tasks_for_today',
    {
      description: 'Plan multiple tasks for today (adds to Today view) or unplan them. Uses partial-success semantics.',
      inputSchema: planTasksForTodaySchema,
    },
    async ({ task_ids, unplan }) => {
      if (!task_ids?.length) return okResult({ results: [] });
      const now = new Date();
      const plannedAt = unplan ? null : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const updates = task_ids.map(id => ({ taskId: id, data: { plannedAt } }));
      const res = await sendCommand(dirs, 'bulkUpdateTasks', { updates });
      if (!res.success) return errorResult(res.error ?? 'Failed to plan tasks');
      return okResult(res.result);
    },
  );

  // get_worklog (US5 — registered here since it uses task data)
  server.registerTool(
    'get_worklog',
    {
      description: 'Get a worklog summary for a date range: time spent per day, per project, per tag, tasks completed, and estimate vs actual accuracy.',
      inputSchema: getWorklogSchema,
    },
    async ({ start_date, end_date }) => {
      if (!start_date || !end_date) return errorResult('start_date and end_date are required');

      const res = await sendCommand(dirs, 'getTasks', {
        filters: { includeDone: true, includeArchived: true },
      });
      if (!res.success) return errorResult(res.error ?? 'Failed to get tasks');

      const tasks = (res.result as TaskRecord[]) ?? [];
      const daily: Record<string, number> = {};
      const byProject: Record<string, number> = {};
      const byTag: Record<string, number> = {};
      let completedCount = 0;
      let totalEstimate = 0;
      let totalActual = 0;

      for (const task of tasks) {
        // Aggregate timeSpentOnDay within range
        if (task.timeSpentOnDay) {
          for (const [date, ms] of Object.entries(task.timeSpentOnDay)) {
            if (date >= start_date && date <= end_date) {
              daily[date] = (daily[date] ?? 0) + ms;
              const proj = task.projectId ?? 'No Project';
              byProject[proj] = (byProject[proj] ?? 0) + ms;
              for (const tagId of task.tagIds ?? []) {
                byTag[tagId] = (byTag[tagId] ?? 0) + ms;
              }
            }
          }
        }
        // Count completions in range
        if (task.isDone && task.doneOn) {
          const d = new Date(task.doneOn);
          const doneDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (doneDate >= start_date && doneDate <= end_date) {
            completedCount++;
            if (task.timeEstimate > 0) {
              totalEstimate += task.timeEstimate;
              totalActual += task.timeSpent;
            }
          }
        }
      }

      return okResult({
        dateRange: { start: start_date, end: end_date },
        daily,
        byProject,
        byTag,
        tasksCompleted: completedCount,
        estimateAccuracy: totalEstimate > 0
          ? { estimateMs: totalEstimate, actualMs: totalActual, ratio: totalActual / totalEstimate }
          : null,
      });
    },
  );

  // log_time — writes the per-day map get_worklog reads
  server.registerTool(
    'log_time',
    {
      description: 'Log time spent on a task for a specific day. Adds to that day\'s tracked time by default, or overwrites it with mode "set" (pass 0m with "set" to clear a day). Time lands in the same per-day record SP\'s own timer writes, so it shows up in the worklog and rolls up to the parent task.',
      inputSchema: logTimeSchema,
    },
    async ({ task_id, duration, date, entries, mode }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');

      if (entries !== undefined && duration !== undefined) {
        return errorResult('Pass either duration (one day) or entries (several days), not both');
      }
      if (entries === undefined && duration === undefined) {
        return errorResult('Pass duration to log one day, or entries to log several');
      }
      if (entries !== undefined && date !== undefined) {
        return errorResult('date is only meaningful alongside duration — put each day\'s date in its entries element instead');
      }

      // The single-day form is just a one-entry list — one validation path and one
      // wire shape, so the two forms cannot drift apart.
      const requested = entries ?? [{ date: date ?? localDateStr(), duration: duration as string }];
      if (requested.length === 0) return errorResult('entries must contain at least one day');

      // Validate everything before sending: a partially-applied multi-day write
      // would leave the worklog in a state the caller never asked for.
      const seen = new Set<string>();
      const normalised: { date: string; durationMs: number }[] = [];
      for (const entry of requested) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
          return errorResult(`Invalid date "${entry.date}" — expected ISO format YYYY-MM-DD`);
        }
        if (seen.has(entry.date)) {
          return errorResult(`Duplicate date "${entry.date}" in entries — one entry per day`);
        }
        seen.add(entry.date);

        const durationMs = parseDuration(entry.duration ?? '');
        if (durationMs === null) {
          return errorResult(`Invalid duration "${entry.duration}" for ${entry.date} — use SP short syntax, e.g. 2h, 45m, 1h30m or 90s`);
        }
        normalised.push({ date: entry.date, durationMs });
      }

      const res = await sendCommand(dirs, 'logTimeEntries', {
        taskId: task_id,
        data: { entries: normalised, mode: mode ?? 'add' },
      });
      if (!res.success) return errorResult(res.error ?? 'Failed to log time');
      return okResult(res.result);
    },
  );

  server.registerTool(
    'get_task_repeat_cfgs',
    {
      description: 'Get all recurring task configurations (taskRepeatCfg) from Super Productivity. Returns repeat schedules with their cycle, frequency, day settings, and associated task metadata.',
      inputSchema: getTaskRepeatCfgsSchema,
    },
    async () => {
      const res = await sendCommand(dirs, 'getTaskRepeatCfgs');
      if (!res.success) return errorResult(res.error ?? 'Failed to get repeat configs');
      return okResult({ repeatCfgs: res.result });
    },
  );

  // create_task_repeat_cfg — attach a repeat config to an existing task (SP PR #9798)
  server.registerTool(
    'create_task_repeat_cfg',
    {
      description: 'Make an existing top-level task repeat by attaching a new repeat config to it. The config inherits the task\'s project, and its title defaults to the task\'s title. Without repeat_cycle the task repeats every day. The task cannot be a subtask, an issue task, or already repeating. Requires an SP build with the repeat-cfg plugin API (SP PR #9798); returns the created config\'s ID.',
      inputSchema: createTaskRepeatCfgSchema,
    },
    async ({ task_id, ...cfgFields }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');

      const patch = mapRepeatCfgData(cfgFields as Record<string, unknown>);
      // Coherence on the patch alone: the effective cycle is the patch's, or DAILY.
      const effectiveCycle = (patch.repeatCycle as string | undefined) ?? 'DAILY';
      if (setsWeekdayOffWeeklyCycle(effectiveCycle, patch as Partial<Record<RepeatWeekday, unknown>>)) {
        return errorResult(`Weekday flags are only read by the WEEKLY cycle — repeat_cycle "${effectiveCycle}" would store and silently ignore them`);
      }
      const coherenceError = validateRepeatCfgMerged({ repeatCycle: effectiveCycle, ...patch } as Parameters<typeof validateRepeatCfgMerged>[0]);
      if (coherenceError) return errorResult(coherenceError);

      const res = await sendCommand(dirs, 'addTaskRepeatCfg', { taskId: task_id, data: patch });
      if (!res.success) return errorResult(res.error ?? 'Failed to create repeat config');
      return okResult({ repeatCfgId: res.result });
    },
  );

  // update_task_repeat_cfg — change an existing repeat config (SP PR #9798)
  server.registerTool(
    'update_task_repeat_cfg',
    {
      description: 'Update an existing repeat config by ID. Only the provided fields change; the rest keep their current values. Switching the cycle to WEEKLY requires at least one weekday to remain set overall. Requires an SP build with the repeat-cfg plugin API (SP PR #9798).',
      inputSchema: updateTaskRepeatCfgSchema,
    },
    async ({ repeat_cfg_id, ...cfgFields }) => {
      if (!repeat_cfg_id?.trim()) return errorResult('repeat_cfg_id is required');

      // Validation runs against the merged result, not the patch: a cfg can be
      // switched to WEEKLY while keeping its weekday flags, or lose its last
      // flagged day — both leave a config that never produces an occurrence.
      const listRes = await sendCommand(dirs, 'getTaskRepeatCfgs');
      if (!listRes.success) return errorResult(listRes.error ?? 'Failed to get repeat configs');
      const existing = ((listRes.result as Array<Record<string, unknown>>) ?? []).find(c => c.id === repeat_cfg_id);
      if (!existing) return errorResult(`Repeat config not found: ${repeat_cfg_id}`);

      const patch = mapRepeatCfgData(cfgFields as Record<string, unknown>);
      const merged = { ...existing, ...patch } as Parameters<typeof validateRepeatCfgMerged>[0];
      if (setsWeekdayOffWeeklyCycle(merged.repeatCycle as string | undefined, patch as Partial<Record<RepeatWeekday, unknown>>)) {
        return errorResult(`Weekday flags are only read by the WEEKLY cycle — repeat_cycle "${merged.repeatCycle}" would store and silently ignore them`);
      }
      const coherenceError = validateRepeatCfgMerged(merged);
      if (coherenceError) return errorResult(coherenceError);

      const res = await sendCommand(dirs, 'updateTaskRepeatCfg', { repeatCfgId: repeat_cfg_id, data: patch });
      if (!res.success) return errorResult(res.error ?? 'Failed to update repeat config');
      return okResult({ success: true });
    },
  );

  // delete_task_repeat_cfg — stop a recurrence (SP PR #9798)
  server.registerTool(
    'delete_task_repeat_cfg',
    {
      description: 'Delete a repeat config by ID. The tasks it already created stay, but stop repeating (this is irreversible and reaches every task the config produced). Requires the deleteTaskRepeatCfg plugin permission and an SP build with the repeat-cfg plugin API (SP PR #9798).',
      inputSchema: deleteTaskRepeatCfgSchema,
    },
    async ({ repeat_cfg_id }) => {
      if (!repeat_cfg_id?.trim()) return errorResult('repeat_cfg_id is required');
      const res = await sendCommand(dirs, 'deleteTaskRepeatCfg', { repeatCfgId: repeat_cfg_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to delete repeat config');
      return okResult({ success: true });
    },
  );
}
