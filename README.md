# Reflect

Reflect is an Obsidian plugin for coming back to what you’ve written. It brings related passages together so you can see which ideas keep coming up. Each passage links back to the note it came from.

**Pre-alpha.** I’m still exploring how Reflect can help you come back to your notes. The workflow may change as I learn what people find useful.

## See Reflect in use

**Browse passages.** Revisit your notes by date and follow an idea that shows up in more than one passage.

![Browse in Reflect, showing dated passages and a related idea in a sample vault.](docs/screenshots/browse.png)

**Read and keep an idea.** Read the interpretation alongside the original passages. Keep the idea as a note if you want to come back to it.

![A draft idea in Reflect, showing the interpretation, two original passages, and the Keep idea button.](docs/screenshots/idea.png)

## Install

Reflect requires Obsidian Desktop 1.15.0 or later. This release has been tested on macOS.

For a manual install, download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/faradayfury/reflect/releases/latest). Put them in your vault's `.obsidian/plugins/reflect` folder. Restart Obsidian, open **Settings → Community plugins**, and enable **Reflect**.

## Use Reflect

- Open **Reflect** to see recent passages in **Browse**. You can also browse by date, people and places, themes, or projects without setting up a model.
- Select **Find ideas in my notes** to look for recurring ideas across the vault. Review what the scan sends to OpenAI before you select **Run scan**. Reflect opens the first idea alongside the passages it found.
- Open **Ideas** to read drafts and kept ideas. **Keep idea** saves a Markdown note with links to its sources. To add links back from the source notes, select **Choose source links** before keeping the idea.
- Choose **Reflect on this note** in a note’s menu or the command palette. Select **Find related ideas**, read the quoted passages, and choose **Add source** if the note adds something to an idea.
- Select **Look for more ideas** from **Ideas** to find new drafts or more sources for ideas you already have.
- **Ask your notes** to explore a question across your vault and save the findings with their original passages.

## Set up the models

Install and start Ollama for local suggestions, then run `ollama pull qwen3:4b`. Reflect checks the local Ollama ports `11434` and `11439`. [Download Ollama](https://ollama.com/download)

Astra features require the Codex CLI and an account with access to Astra. Install the CLI and run `codex login`. To check your setup, run `codex login status` or `ollama list` in Terminal. [Codex CLI setup](https://learn.chatgpt.com/docs/codex/cli)

Reflect is free and can browse passages without an account. The optional Astra features use your own OpenAI account and may require a paid plan or usage credits.

## Data and privacy

Reflect reads Markdown and keeps its review data in your vault. It updates notes when you choose to keep an idea, add a source, or save a link.

- **Ollama.** Local discovery can run in the background when the vault is open. Reflect sends relevant note excerpts, idea summaries, and review preferences to Ollama on your computer for suggestions and feedback rechecks.
- **Astra.** When you run an Astra scan or submit a question, Reflect sends eligible note text, titles, dates, and relevant review context to OpenAI through your signed-in Codex CLI. Reflect starts the external CLI and uses a temporary system directory outside your vault for the answer. It removes that directory after the request.

## License

Reflect is licensed under the [MIT License](LICENSE). The bundled Newsreader typeface is licensed separately under the [SIL Open Font License](Newsreader-OFL.txt).
