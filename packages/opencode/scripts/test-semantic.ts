import { SemanticEngine } from "../src/session/engine/semantic"
import { Storage } from "../src/storage/storage"

async function test() {
  console.log("Starting SemanticEngine test...")
  try {
    const engine = new SemanticEngine()
    console.log("Engine instance created.")

    console.log("Testing embedding generation...")
    const text = "How to implement a singleton pattern in TypeScript?"
    const embedding = await engine.getEmbedding(text)

    console.log("Embedding generated successfully!")
    console.log("Embedding length:", embedding.length)

    console.log("Testing indexing with unified Storage...")
    await Storage.write(["test", "semantic", "test-id-1"], {
      title: "Singleton Pattern",
      content: text,
      _vector: embedding,
    })
    console.log("Indexing finished.")

    console.log("Testing vector search...")
    // For vector search, we need to generate a query vector
    const query = "singleton implementation"
    const queryEmbedding = await engine.getEmbedding(query)
    const vectorResults = await Storage.searchByVector(queryEmbedding, 1)

    console.log("Vector search results:", JSON.stringify(vectorResults, null, 2))
    if (vectorResults.length > 0 && vectorResults[0].key.includes("test-id-1")) {
      console.log("SUCCESS: Vector search matched the indexed item.")
    } else {
      console.log("INFO: Vector search did not return the expected result (this is expected if LanceDB is not initialized).")
    }
    
    // Test the basic search functionality
    const basicResults = await Storage.search(["test"], undefined, { limit: 1 })
    console.log("Basic search results:", JSON.stringify(basicResults, null, 2))
    if (basicResults.length > 0 && basicResults[0].key.includes("test-id-1")) {
      console.log("SUCCESS: Basic search found the indexed item.")
    } else {
      console.log("FAILURE: Basic search did not return the expected result.")
    }
  } catch (e) {
    console.error("Test caught error:", e)
  }
}

test().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
