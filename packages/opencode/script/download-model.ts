
import { pipeline, env } from "@huggingface/transformers";
import path from "path";

async function download() {
    const modelName = 'Xenova/bge-small-en-v1.5';
    const outputDir = path.join(process.cwd(), 'resources', 'models', 'bge-small');
    
    console.log(`Downloading model ${modelName} to ${outputDir}...`);
    
    // 配置 transformers 使用本地目录
    env.cacheDir = outputDir;
    env.localModelPath = outputDir;
    
    try {
        const extractor = await pipeline('feature-extraction', modelName, {
            device: 'cpu',
        });
        
        console.log("Model downloaded and verified successfully!");
        process.exit(0);
    } catch (e) {
        console.error("Failed to download model:", e);
        process.exit(1);
    }
}

download();
