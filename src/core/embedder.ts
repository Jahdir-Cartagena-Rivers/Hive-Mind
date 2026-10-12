// @effect-diagnostics nodeBuiltinImport:off - model files live in the environment's data directory.
// @effect-diagnostics globalFetch:off - one-time model download streamed straight to disk.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MODEL = "Xenova/bge-small-en-v1.5";

interface Embedder {
  embed(text: string): Promise<Float32Array>;
}
const MODEL_FILES = ["tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];
const MAX_TOKENS = 512;

/** One-time download into the environment's data directory; afterwards it runs offline. */
async function ensureModelFiles(modelDir: string) {
  for (const name of MODEL_FILES) {
    const target = NodePath.join(modelDir, name);
    if ((await NodeFSP.stat(target).catch(() => undefined))?.isFile()) continue;
    const response = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${name}`);
    if (!response.ok) throw new Error(`Embedding model download failed (HTTP ${response.status}).`);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    const partial = `${target}.${process.pid}.part`;
    await NodeFSP.writeFile(partial, Buffer.from(await response.arrayBuffer()));
    await NodeFSP.rename(partial, target);
  }
}

const embedders = new Map<string, Promise<Embedder>>();
function loadEmbedder(modelDir: string) {
  let embedder = embedders.get(modelDir);
  if (!embedder) {
    embedder = (async () => {
      await ensureModelFiles(modelDir);
      const [{ Tokenizer }, ort] = await Promise.all([
        import("@huggingface/tokenizers"),
        import("onnxruntime-node"),
      ]);
      const read = async (name: string) =>
        JSON.parse(await NodeFSP.readFile(NodePath.join(modelDir, name), "utf8"));
      const tokenizer = new Tokenizer(
        await read("tokenizer.json"),
        await read("tokenizer_config.json"),
      );
      // Two CPU threads: background indexing should never be noticeable.
      const session = await ort.InferenceSession.create(
        NodePath.join(modelDir, "onnx/model_quantized.onnx"),
        { intraOpNumThreads: 2, interOpNumThreads: 1 },
      );
      return {
        async embed(text: string) {
          const ids = tokenizer.encode(text).ids.slice(0, MAX_TOKENS);
          const shape = [1, ids.length];
          const tensor = (values: number[]) =>
            new ort.Tensor("int64", BigInt64Array.from(values, BigInt), shape);
          const output = await session.run({
            input_ids: tensor(ids),
            attention_mask: tensor(ids.map(() => 1)),
            token_type_ids: tensor(ids.map(() => 0)),
          });
          // CLS pooling over the first token, then L2 normalization.
          const hidden = output["last_hidden_state"]!;
          const vector = Float32Array.from((hidden.data as Float32Array).subarray(0, 384));
          const length = Math.hypot(...vector) || 1;
          return vector.map((value) => value / length);
        },
      };
    })();
    // A failed download must not be remembered; the next sync retries.
    embedder.catch(() => embedders.delete(modelDir));
    embedders.set(modelDir, embedder);
  }
  return embedder;
}

/** Unit-length 384-dimension vectors from a local ONNX model, one per text. */
export async function embedTexts(modelDir: string, texts: string[]) {
  const embedder = await loadEmbedder(modelDir);
  const vectors: Float32Array[] = [];
  for (const text of texts) vectors.push(await embedder.embed(text));
  return vectors;
}
