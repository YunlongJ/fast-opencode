
import { SemanticEngine } from "../src/session/engine/semantic";

async function test() {
    console.log("Starting SemanticEngine test...");
    try {
        const engine = new SemanticEngine();
        console.log("Engine instance created.");
        
        console.log("Testing embedding generation...");
        const text = "How to implement a singleton pattern in TypeScript?";
        const embedding = await engine.getEmbedding(text);
        
        console.log("Embedding generated successfully!");
        console.log("Embedding length:", embedding.length);
        
        console.log("Testing indexing...");
        await engine.indexItem("test-id-1", "Singleton Pattern", embedding);
        console.log("Indexing finished.");
        
        console.log("Testing search...");
        const query = "singleton implementation";
        const queryVector = await engine.getEmbedding(query);
        const results = await engine.search(query, queryVector, 1);
        
        console.log("Search results:", JSON.stringify(results, null, 2));
        if (results.length > 0 && results[0].id === "test-id-1") {
            console.log("SUCCESS: Search matched the indexed item.");
        } else {
            console.log("FAILURE: Search did not return the expected result.");
        }
    } catch (e) {
        console.error("Test caught error:", e);
    }
}

test().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
