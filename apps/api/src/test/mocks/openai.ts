import { vi } from "vitest";

export const mockCreate = vi.fn().mockResolvedValue({
  choices: [{ message: { content: "{}" } }],
});

class OpenAI {
  chat = {
    completions: {
      create: mockCreate,
    },
  };
}

export default OpenAI;
// Real "openai" exposes both a default export and a named `OpenAI` export pointing to the same
// class — mirror that here so services using either import style (e.g. `import { OpenAI }`) work.
export { OpenAI };
