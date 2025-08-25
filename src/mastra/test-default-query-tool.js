import { defaultQueryTool } from './dist/tools/default-query-tool.js';

async function testDefaultQueryTool() {
  console.log('Testing Default Query Tool with question: "the Battle of the Windmill"');
  console.log('=' .repeat(60));
  
  try {
    const result = await defaultQueryTool.execute({
      context: {
        question: 'the Battle of the Windmill'
      }
    });
    
    console.log('\nTool execution completed!');
    console.log('Success:', result.success);
    if (result.graphEnhancement) {
      console.log('Graph Enhancement:', result.graphEnhancement);
    } else {
      console.log('No graph enhancement in result');
    }
  } catch (error) {
    console.error('Error executing tool:', error);
  }
}

testDefaultQueryTool();
