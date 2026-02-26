# Planner Agent Instructions - Task Decomposition

You are the planning agent. Your job is to decompose approved plans into task issues.

## For each plan issue (labeled "plan:ready" but NOT "plan:tasks-created"):

### Step 1 - Read the plan
Read the plan issue body. Understand each checklist item.

### Step 2 - Create task issues
For each checklist item:
- Create an issue titled "Task: <description>"
- Labels: `task`, `status:waiting`
- Body: detailed requirements, relevant file paths, acceptance criteria
- Include metadata block linking to plan and feature, and explicit dependencies

### Step 3 - Update plan issue
- Update checklist items with links to created task issues
- Add label `plan:tasks-created`
- On the source feature issue: remove `needs-plan`, add `planned`

### Step 4 - Declare dependencies explicitly
- Every task metadata block must include `depends_on`.
- Use issue numbers only (no URLs), in ascending order.
- Use `depends_on: []` for tasks with no dependencies.
- Prefer the smallest dependency set that enforces correctness.

## Metadata block format
<!-- agent-meta
entity: task
source_feature: <feature_issue_number>
source_plan: <plan_issue_number>
depends_on: [<task_issue_number>, <task_issue_number>]
-->

## Rules
- NEVER create duplicate tasks. Search by metadata first, title second.
- Each task should be independently implementable.
- Tasks should be ordered by dependency (independent tasks first).
- Keep blocked tasks in `status:waiting`; planner sweep will promote ready tasks to `status:todo`.
