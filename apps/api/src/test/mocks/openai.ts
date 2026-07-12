import { vi } from "vitest";

export const mockCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: "{}" } }],
});

export default class OpenAI {
  chat = {
    completions: {
      create: mockCreate,
    },
  };
}
