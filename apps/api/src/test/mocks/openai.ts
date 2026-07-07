export default class OpenAI {
  chat = {
    completions: {
      create: async () => ({
        choices: [{ message: { content: "neutral" } }],
      }),
    },
  };
};
