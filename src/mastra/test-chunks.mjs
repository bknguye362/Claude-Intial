import { processPDF } from './dist/lib/pdf-processor.js';
import fs from 'fs';

async function testChunking() {
  console.log('Testing LLM chunking on a sample text...\n');
  
  // Create a sample text file
  const sampleText = `Chapter 1: The Beginning

Once upon a time, in a small village nestled between rolling hills, there lived a young farmer named Jack. Jack was known throughout the village for his kindness and hard work. Every morning, he would wake up before dawn to tend to his crops and animals.

The village was peaceful, with cobblestone streets and thatched-roof houses. Children played in the square while merchants sold their wares at the market. Life moved at a gentle pace, following the rhythm of the seasons.

Chapter 2: The Discovery

One day, while plowing his field, Jack's plow struck something hard buried in the earth. Curious, he dug around the object and discovered an ancient wooden box. The box was ornately carved with symbols he couldn't understand. Inside, he found a map and a golden compass that seemed to glow with an inner light.

The map showed a path leading from his village through the Dark Forest to a mountain marked with an X. Jack had heard stories of the Dark Forest from the village elders. They spoke of strange creatures and magical phenomena that occurred within its shadowy depths.

Chapter 3: The Journey Begins

After much deliberation, Jack decided to follow the map. He packed supplies for a long journey: bread, cheese, dried meat, and his father's old sword. His best friend, Thomas, insisted on joining him. "You'll need someone to watch your back," Thomas said with a grin.

They set off at dawn, walking along the familiar road that led out of the village. As they approached the edge of the Dark Forest, the temperature dropped noticeably. The trees seemed to lean inward, creating a natural archway that beckoned them forward.

The forest was unlike anything they had ever seen. Ancient trees towered above them, their branches intertwining to form a canopy so thick that only scattered beams of sunlight penetrated to the forest floor. Strange flowers glowed softly in the shadows, and they could hear the distant calls of unknown creatures.

As night fell, they made camp in a small clearing. The golden compass continued to glow, pointing steadily toward the mountain. They took turns keeping watch, but the night passed peacefully, with only the occasional hoot of an owl breaking the silence.`;

  // Save the sample text
  const testFile = '/tmp/test-story.txt';
  fs.writeFileSync(testFile, sampleText);
  
  console.log('Processing sample text with LLM chunking...\n');
  console.log('Text length:', sampleText.length, 'characters\n');
  
  try {
    const result = await processPDF(testFile);
    
    if (result.success) {
      console.log('✅ Processing successful!');
      console.log('Index name:', result.indexName);
      console.log('Total chunks created:', result.totalChunks);
      console.log('\nExamining chunk boundaries:\n');
      
      // The chunks are stored in the result
      if (result.chunks && result.chunks.length > 0) {
        result.chunks.forEach((chunk, idx) => {
          console.log(`\n========== CHUNK ${idx + 1} ==========`);
          console.log('Length:', chunk.length, 'characters');
          console.log('\nFIRST 150 chars:');
          console.log(chunk.substring(0, 150) + '...');
          console.log('\nLAST 150 chars:');
          console.log('...' + chunk.substring(chunk.length - 150));
          console.log('-----------------------------------');
        });
      }
    } else {
      console.error('Processing failed:', result.error);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

testChunking().catch(console.error);