#!/usr/bin/env node

// Standalone script to manage S3 Vector indices
import { deleteIndex, deleteAllIndices, deleteIndicesByPattern, listIndicesWithDetails, getIndexInfo } from './lib/index-manager.js';

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];
  
  console.log('S3 Vectors Index Manager');
  console.log('========================\n');
  
  switch (command) {
    case 'list':
      console.log('Listing all indices...\n');
      const indices = await listIndicesWithDetails();
      
      if (indices.length === 0) {
        console.log('No indices found.');
      } else {
        console.log(`Found ${indices.length} indices:\n`);
        indices.forEach((idx, i) => {
          console.log(`${i + 1}. ${idx.name}`);
          console.log(`   Vectors: ${idx.vectorCount || 'unknown'}`);
          console.log(`   Dimension: ${idx.dimension || 'unknown'}\n`);
        });
      }
      break;
      
    case 'delete':
      if (!arg) {
        console.error('Error: Index name required');
        console.log('Usage: npm run manage-indices delete <index-name>');
        process.exit(1);
      }
      
      console.log(`Deleting index: ${arg}`);
      console.log('Are you sure? Press Ctrl+C to cancel, or wait 3 seconds...\n');
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const success = await deleteIndex(arg);
      if (success) {
        console.log(`✅ Successfully deleted index: ${arg}`);
      } else {
        console.log(`❌ Failed to delete index: ${arg}`);
      }
      break;
      
    case 'delete-all':
      console.log('⚠️  WARNING: This will delete ALL indices!');
      console.log('Are you sure? Type "yes" to confirm: ');
      
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const answer = await new Promise<string>(resolve => {
        rl.question('', resolve);
      });
      rl.close();
      
      if (answer.toLowerCase() === 'yes') {
        console.log('\nDeleting all indices...\n');
        const result = await deleteAllIndices();
        console.log(`\nDeleted ${result.deleted} of ${result.total} indices`);
        if (result.failed.length > 0) {
          console.log(`Failed to delete: ${result.failed.join(', ')}`);
        }
      } else {
        console.log('Cancelled.');
      }
      break;
      
    case 'delete-pattern':
      if (!arg) {
        console.error('Error: Pattern required');
        console.log('Usage: npm run manage-indices delete-pattern <pattern>');
        console.log('Example: npm run manage-indices delete-pattern "test-.*"');
        process.exit(1);
      }
      
      console.log(`Finding indices matching pattern: ${arg}\n`);
      const allIndices = await listIndicesWithDetails();
      const regex = new RegExp(arg);
      const matching = allIndices.filter(idx => regex.test(idx.name));
      
      if (matching.length === 0) {
        console.log('No matching indices found.');
      } else {
        console.log(`Found ${matching.length} matching indices:`);
        matching.forEach(idx => console.log(`  - ${idx.name}`));
        
        console.log('\nPress Ctrl+C to cancel, or wait 3 seconds...\n');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const result = await deleteIndicesByPattern(arg);
        console.log(`\nDeleted ${result.deleted} of ${result.total} indices`);
        if (result.failed.length > 0) {
          console.log(`Failed to delete: ${result.failed.join(', ')}`);
        }
      }
      break;
      
    case 'info':
      if (!arg) {
        console.error('Error: Index name required');
        console.log('Usage: npm run manage-indices info <index-name>');
        process.exit(1);
      }
      
      console.log(`Getting info for index: ${arg}\n`);
      const info = await getIndexInfo(arg);
      
      if (info.exists) {
        console.log(`Index: ${arg}`);
        console.log(`Vectors: ${info.vectorCount}`);
        console.log(`Dimension: ${info.dimension}`);
      } else {
        console.log(`Index '${arg}' not found`);
        if (info.error) {
          console.log(`Error: ${info.error}`);
        }
      }
      break;
      
    default:
      console.log('Usage: npm run manage-indices <command> [args]');
      console.log('\nCommands:');
      console.log('  list                    - List all indices with details');
      console.log('  delete <name>           - Delete a specific index');
      console.log('  delete-all              - Delete ALL indices (requires confirmation)');
      console.log('  delete-pattern <regex>  - Delete indices matching pattern');
      console.log('  info <name>             - Get information about an index');
      console.log('\nExamples:');
      console.log('  npm run manage-indices list');
      console.log('  npm run manage-indices delete test-index');
      console.log('  npm run manage-indices delete-pattern "^test-.*"');
      console.log('  npm run manage-indices info my-index');
  }
}

// Run the script
main().catch(console.error);