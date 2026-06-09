export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Memory {
  prd: string;
  rules: string;
  skills: string;
}

export interface Chat {
  id: string;
  name: string;
  project: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
}
