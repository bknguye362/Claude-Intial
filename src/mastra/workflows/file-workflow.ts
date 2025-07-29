import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { processPDF } from '../lib/pdf-processor.js';

// Check if input is a question
function isQuestion(input: string): boolean {
  const questionPatterns = [
    /\?/,
    /^what\s/i,
    /^how\s/i,
    /^why\s/i,
    /^when\s/i,
    /^where\s/i,
    /^who\s/i,
    /^which\s/i,
    /^explain\s/i,
    /^can\s/i,
    /^could\s/i,
    /^should\s/i,
    /^would\s/i,
    /^is\s/i,
    /^are\s/i,
    /^do\s/i,
    /^does\s/i,
    /^did\s/i,
  ];
  
  return questionPatterns.some(pattern => pattern.test(input));
}

// Step 1: Analyze file upload
const analyzeFileUpload = createStep({
  id: 'analyze-file-upload',
  description: 'Analyzes message for file uploads, especially PDFs',
  inputSchema: z.object({
    message: z.string().describe('User message to analyze'),
  }),
  outputSchema: z.object({
    message: z.string(),
    hasPdf: z.boolean(),
    pdfPath: z.string().optional(),
    fileName: z.string().optional(),
    actualUserMessage: z.string(),
    hasQuestion: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    console.log('[File Workflow - AnalyzeFile] Step executed with input:', inputData);
    
    if (!inputData) {
      throw new Error('Input data not found');
    }

    const message = inputData.message;
    console.log('[File Workflow - AnalyzeFile] Checking message for files...');
    
    // Check for uploaded files
    const uploadedFileMatch = message.match(/\[Uploaded files: ([^\]]+)\]/);
    const fileTaskMatch = message.match(/\[FILE_AGENT_TASK\]\s*([^(]+)\s*\(([^)]+)\)/);
    
    let pdfPath: string | null = null;
    let fileName: string | null = null;
    
    if (fileTaskMatch) {
      pdfPath = fileTaskMatch[2];
      fileName = pdfPath.split('/').pop() || 'unknown';
    } else if (uploadedFileMatch) {
      const fileInfo = uploadedFileMatch[1];
      const pathMatch = fileInfo.match(/([^(]+)\s*\(([^)]+)\)/);
      if (pathMatch) {
        fileName = pathMatch[1].trim();
        pdfPath = pathMatch[2];
      }
    }
    
    // Extract actual user message
    let actualUserMessage = message;
    if (uploadedFileMatch) {
      actualUserMessage = message.replace(/\[Uploaded files: [^\]]+\]\n?/, '').trim();
    } else if (fileTaskMatch) {
      actualUserMessage = message.replace(/\[FILE_AGENT_TASK\][^)]+\)\s*/, '').trim();
    }
    
    const hasPdf = !!(pdfPath && pdfPath.toLowerCase().endsWith('.pdf'));
    const hasQuestion = !!(actualUserMessage && isQuestion(actualUserMessage));
    
    console.log('[File Workflow - AnalyzeFile] Analysis results:', {
      hasPdf,
      pdfPath,
      fileName,
      actualUserMessage: actualUserMessage || '(empty)',
      hasQuestion
    });
    
    return {
      message: inputData.message,
      hasPdf,
      pdfPath: pdfPath || undefined,
      fileName: fileName || undefined,
      actualUserMessage,
      hasQuestion,
    };
  },
});

// Step 2: Process PDF if detected
const processPdfIfNeeded = createStep({
  id: 'process-pdf-if-needed',
  description: 'Automatically processes PDF files before agent runs',
  inputSchema: z.object({
    message: z.string(),
    hasPdf: z.boolean(),
    pdfPath: z.string().optional(),
    fileName: z.string().optional(),
    actualUserMessage: z.string(),
    hasQuestion: z.boolean(),
  }),
  outputSchema: z.object({
    message: z.string(),
    hasPdf: z.boolean(),
    pdfPath: z.string().optional(),
    fileName: z.string().optional(),
    actualUserMessage: z.string(),
    hasQuestion: z.boolean(),
    pdfProcessed: z.boolean(),
    indexName: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    console.log('[File Workflow - ProcessPDF] Step executed');
    
    let pdfProcessed = false;
    let indexName: string | undefined;
    
    if (inputData.hasPdf && inputData.pdfPath) {
      console.log('[File Workflow - ProcessPDF] PDF detected, processing automatically...');
      
      try {
        // Call the PDF processor function directly
        const result = await processPDF(inputData.pdfPath);
        
        if (result.success) {
          pdfProcessed = true;
          indexName = result.indexName;
          console.log(`[File Workflow - ProcessPDF] PDF processed successfully. Index: ${indexName}`);
        } else {
          console.error('[File Workflow - ProcessPDF] PDF processing failed:', result.error);
        }
      } catch (error) {
        console.error('[File Workflow - ProcessPDF] Error processing PDF:', error);
      }
    }
    
    return {
      ...inputData,
      pdfProcessed,
      indexName,
    };
  },
});

// Step 3: Generate response
const generateFileResponse = createStep({
  id: 'generate-file-response',
  description: 'Generates response using the file agent',
  inputSchema: z.object({
    message: z.string(),
    hasPdf: z.boolean(),
    pdfPath: z.string().optional(),
    fileName: z.string().optional(),
    actualUserMessage: z.string(),
    hasQuestion: z.boolean(),
    pdfProcessed: z.boolean(),
    indexName: z.string().optional(),
  }),
  outputSchema: z.object({
    response: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    console.log('[File Workflow - GenerateResponse] Step executed with input:', inputData);
    
    if (!inputData) {
      throw new Error('Input data not found');
    }
    
    const fileAgent = mastra?.getAgent('fileAgent');
    if (!fileAgent) {
      throw new Error('File agent not found');
    }
    
    let context = '';
    
    // Build context based on what was detected
    if (inputData.hasPdf && inputData.pdfProcessed) {
      // PDF has already been processed by the workflow
      context = `A PDF file (${inputData.fileName}) has been automatically processed and indexed as: ${inputData.indexName}. `;
      context += `The document is now searchable. `;
      
      if (inputData.hasQuestion || inputData.actualUserMessage) {
        context += `Please use defaultQueryTool to answer: "${inputData.actualUserMessage}" `;
      } else {
        context += `Please use defaultQueryTool to provide a comprehensive summary of this document. `;
      }
    } else if (inputData.hasPdf && !inputData.pdfProcessed) {
      // PDF processing failed
      context = `A PDF file (${inputData.fileName}) was uploaded but could not be processed. Please inform the user of this issue. `;
    } else if (inputData.hasQuestion) {
      context = `The user has asked a question. Use defaultQueryTool to find relevant information and answer: "${inputData.actualUserMessage}". `;
    }
    
    if (!context) {
      context = 'Process the user message normally.';
    }
    
    console.log('[File Workflow - GenerateResponse] Using context:', context);
    
    const response = await fileAgent.stream([
      {
        role: 'system',
        content: context,
      },
      {
        role: 'user',
        content: inputData.message,
      },
    ]);
    
    let responseText = '';
    for await (const chunk of response.textStream) {
      process.stdout.write(chunk);
      responseText += chunk;
    }
    
    return { response: responseText };
  },
});

// Create the workflow
const fileWorkflow = createWorkflow({
  id: 'file-workflow',
  inputSchema: z.object({
    message: z.string().describe('User message to process'),
  }),
  outputSchema: z.object({
    response: z.string(),
  }),
})
  .then(analyzeFileUpload)
  .then(processPdfIfNeeded)
  .then(generateFileResponse);

fileWorkflow.commit();

export { fileWorkflow };