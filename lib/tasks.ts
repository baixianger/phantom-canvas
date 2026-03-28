/**
 * In-memory task queue with status tracking
 */

export type MediaType = "image" | "video";

export interface TaskInput {
  prompt: string;
  referenceImages?: string[];
  numImages: number;
  timeoutSecs: number;
  callbackUrl?: string;
  type?: MediaType;  // "image" (default) or "video"
}

export interface TaskMedia {
  path: string;
  type: MediaType;
  mimeType: string;
  base64?: string;
}

// Backward compat alias
export type TaskImage = TaskMedia;

export interface Task {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  input: TaskInput;
  images?: TaskMedia[];  // images and/or videos
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class TaskQueue {
  private tasks = new Map<string, Task>();

  create(input: TaskInput): string {
    const id = crypto.randomUUID().slice(0, 8);
    this.tasks.set(id, {
      id,
      status: "queued",
      input,
      createdAt: Date.now(),
    });
    return id;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, patch: Partial<Task>) {
    const task = this.tasks.get(id);
    if (task) Object.assign(task, patch);
  }

  pending(): number {
    return [...this.tasks.values()].filter(
      (t) => t.status === "queued" || t.status === "running"
    ).length;
  }

  completed(): number {
    return [...this.tasks.values()].filter(
      (t) => t.status === "completed"
    ).length;
  }
}
