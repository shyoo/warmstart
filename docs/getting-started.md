> **Audience:** people installing Warmstart for the first time.  
> **Authority for:** the first-run walkthrough and its task shapes.

# Getting started

## 1. Add an account

Open **Settings → Workers → Add worker**, choose a CLI and press **Sign in**. Warmstart opens the vendor login in an embedded terminal and reads back who signed in; each account has its own isolation directory.

![Workers](images/workers.png)

## 2. Add a project

Press **+** beside Projects. The wizard inspects the directory, asks about worktrees, the landing branch, finish policy and checks, and changes nothing until **Create**.

![New project](images/new-project.png)

## 3. File a task

Use **New task** in the title bar. Its prompt, priority, dependencies, workspace, conversation reuse and finish policy are all visible in the composer.

![New task](images/new-task.png)

| Kind | What it does |
|---|---|
| **Single Task** | Completes autonomously in one turn, including landing, and can ask a question. |
| **Conversation** | A thread you keep talking in; stops after each turn and commits when you say. |
| **Plan & Execute** | One planner hands to one executor, with no review turn. |
| **Plan & Split** | A planner files dependent pieces for several agents, then integrates them. |
| **Debate** | Two to five seats answer blind; an organizer reports agreement with dissent. |

## 4. Watch it work

**Tasks** shows who is running what, branch, duration and price. **Flow** shows the same work through its workspace pool.

![Tasks](images/tasks.png)

![Flow](images/flow.png)

## 5. Answer, review, land

Open a task to read its thread and ledger. Reply resumes the stopped conversation rather than restarting it.

![Thread](images/thread.png)

| Policy | Outcome |
|---|---|
| `await-human` | Stop with the branch intact for review. |
| `commit-only` | Commit on its branch. |
| `commit-and-verify` | Commit, then run project checks. |
| `commit-and-merge` | Commit, verify, then fast-forward the local landing branch. |
| `commit-and-push` | As above, then push. |
| `pull-request` | Push and open a pull request. |
| `custom` | Follow the project instruction. |
| `report-only` | Deliver the thread, not a branch. |

## 6. When one opinion is not enough

Choose **Debate** for two to five independent, blind positions. An organizer can exchange positions between rounds and reports agreement with dissent; then you can execute, split, keep asking or stop.

![Debate](images/debate.png)
