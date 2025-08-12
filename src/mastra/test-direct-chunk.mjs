import { processPDF } from './dist/lib/pdf-processor.js';
import fs from 'fs';

// Directly examine the chunking logic
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

console.log('Sample text length:', sampleText.length, 'characters\n');

// Manual chunking at sentence boundaries
const maxChunkSize = 1000;
const chunks = [];
let currentPos = 0;

while (currentPos < sampleText.length) {
  let endPos = Math.min(currentPos + maxChunkSize, sampleText.length);
  
  // Look for sentence endings
  if (endPos < sampleText.length) {
    const searchWindow = sampleText.substring(Math.max(currentPos, endPos - 200), endPos);
    const sentenceEndings = ['. ', '.\n', '! ', '!\n', '? ', '?\n'];
    
    let bestBreak = -1;
    for (const ending of sentenceEndings) {
      const idx = searchWindow.lastIndexOf(ending);
      if (idx > bestBreak) {
        bestBreak = idx;
      }
    }
    
    if (bestBreak > 0) {
      endPos = Math.max(currentPos, endPos - 200) + bestBreak + 1;
    }
  }
  
  const chunk = sampleText.substring(currentPos, endPos);
  chunks.push(chunk);
  currentPos = endPos;
}

console.log('Created', chunks.length, 'chunks\n');

chunks.forEach((chunk, idx) => {
  console.log(`\n========== CHUNK ${idx + 1} ==========`);
  console.log('Length:', chunk.length, 'characters');
  console.log('\nSTART:', chunk.substring(0, 100) + '...');
  console.log('\nEND: ...' + chunk.substring(chunk.length - 100));
  console.log('-----------------------------------');
});