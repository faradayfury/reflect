# Reflect

Reflect helps you revisit what you have written and see which ideas come up across your notes. Each suggested connection includes passages you can check in the original notes.

## Install

Reflect runs in Obsidian Desktop. This release has been tested on macOS.

For a manual install, download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/faradayfury/reflect/releases/latest). Put them in your vault's `.obsidian/plugins/reflect` folder. Restart Obsidian, open **Settings → Community plugins**, and enable **Reflect**.

## Use Reflect

- **Browse passages** to revisit your notes by date, people and places, themes, or projects. This works with your local vault files.
- **Open ideas** to read drafts and kept ideas alongside their original passages. Keep a draft to save it as a Markdown note. You choose which source notes link back to it.
- **Review active note** to find missing links or see how the current note connects to ideas you already have. Select **Find matching ideas**, check the quoted passages, then choose **Add source** to keep the connection.
- **Scan vault with Astra** to find ideas across your existing notes. Open **Ideas**, select **Scan vault with Astra**, then select **Run scan**. Later scans can add drafts or suggest more sources for existing ideas.
- **Ask your notes** to explore a question across your vault and save the findings with their original passages.

## Set up the models

Install and start Ollama for local suggestions, then run `ollama pull qwen3:4b`. Reflect checks the local Ollama ports `11434` and `11439`. [Download Ollama](https://ollama.com/download)

Astra features require the Codex CLI and an account with access to Astra. Install the CLI and run `codex login`. To check your setup, run `codex login status` or `ollama list` in Terminal. [Codex CLI setup](https://learn.chatgpt.com/docs/codex/cli)

## Data and privacy

Reflect reads Markdown and keeps its review data in your vault. It updates notes when you choose to keep an idea, add a source, or save a link.

- **Ollama.** Local discovery can run in the background when the vault is open. Reflect sends relevant note excerpts, idea summaries, and review preferences to Ollama on your computer for suggestions and feedback rechecks.
- **Astra.** When you run an Astra scan or submit a question, Reflect sends eligible note text, titles, dates, and relevant review context to OpenAI through your signed-in Codex CLI. Reflect starts the external CLI and uses a temporary system directory outside your vault for the answer. It removes that directory after the request.

## License

Reflect is licensed under the [MIT License](LICENSE). The bundled Newsreader typeface is licensed separately under the [SIL Open Font License](Newsreader-OFL.txt).
