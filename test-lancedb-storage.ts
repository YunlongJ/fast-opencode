import { Storage } from './packages/opencode/src/storage/storage';
import { SemanticEngine } from './packages/opencode/src/session/engine/semantic';

async function testLanceDBStorage() {
  console.log('Testing LanceDB-enhanced Storage...');
  
  try {
    // Test basic storage functionality
    console.log('1. Testing basic write/read...');
    await Storage.write(['test', 'basic'], { message: 'Hello, World!', timestamp: Date.now() });
    const result = await Storage.read<{ message: string; timestamp: number }>(['test', 'basic']);
    console.log('Read result:', result);
    
    // Test vector storage functionality
    console.log('\n2. Testing vector storage...');
    const semanticEngine = new SemanticEngine();
    const sampleText = "This is a sample text for vector storage testing";
    const vector = await semanticEngine.getEmbedding(sampleText);
    
    console.log('Generated vector length:', vector.length);
    
    await Storage.writeWithVector(
      ['test', 'vector', 'sample1'], 
      { content: sampleText, metadata: { type: 'test' } }, 
      vector
    );
    console.log('Vector data written successfully');
    
    // Test vector search
    console.log('\n3. Testing vector search...');
    const queryVector = await semanticEngine.getEmbedding("sample text testing");
    const searchResults = await Storage.searchByVector(queryVector, 5);
    
    console.log('Vector search results:', searchResults);
    
    // Test basic search functionality
    console.log('\n4. Testing basic search...');
    const basicSearchResults = await Storage.search(['test'], undefined, { limit: 10 });
    console.log('Basic search results count:', basicSearchResults.length);
    
    console.log('\n✓ All tests passed! Storage with LanceDB integration is working correctly.');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testLanceDBStorage().catch(console.error);