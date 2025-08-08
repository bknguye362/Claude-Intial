// Chat functionality
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const agentSelect = document.getElementById('agent-select');
const fileInput = document.getElementById('file-input');
const fileButton = document.getElementById('file-button');
const filePreview = document.getElementById('file-preview');
const fileName = document.getElementById('file-name');
const removeFileButton = document.getElementById('remove-file');

let selectedFile = null;

// Auto-scroll to bottom
function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Add message to chat
function addMessage(content, isUser = false, isError = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isUser ? 'user' : isError ? 'error' : 'assistant'}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = content;
    
    messageDiv.appendChild(contentDiv);
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

// Show typing indicator
function showTypingIndicator() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message assistant typing-message';
    typingDiv.innerHTML = `
        <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;
    chatMessages.appendChild(typingDiv);
    scrollToBottom();
    return typingDiv;
}

// Send message to API with streaming support
async function sendMessageStream() {
    const message = chatInput.value.trim();
    if (!message && !selectedFile) return;
    
    // Disable input while sending
    chatInput.disabled = true;
    sendButton.disabled = true;
    fileButton.disabled = true;
    
    // Add user message
    if (message) {
        addMessage(message + (selectedFile ? ` [Attached: ${selectedFile.name}]` : ''), true);
    } else if (selectedFile) {
        addMessage(`[Attached: ${selectedFile.name}]`, true);
    }
    
    // Clear input
    chatInput.value = '';
    
    // Create a message div for streaming updates
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message assistant';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.textContent = 'Processing your request...';
    messageDiv.appendChild(contentDiv);
    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    
    try {
        const agentId = agentSelect.value;
        
        // Use EventSource for Server-Sent Events
        const response = await fetch('/chat-stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: message || '',
                agentId: agentId
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'status') {
                        // Update status message
                        contentDiv.textContent = data.message;
                        scrollToBottom();
                    } else if (data.type === 'result') {
                        // Final result received
                        if (data.data?.choices?.[0]?.message?.content) {
                            contentDiv.textContent = data.data.choices[0].message.content;
                            scrollToBottom();
                        }
                    } else if (data.type === 'error') {
                        contentDiv.textContent = `Error: ${data.message}`;
                        messageDiv.className = 'message error';
                        scrollToBottom();
                    }
                }
            }
        }
        
        // Clear file after sending
        if (selectedFile) {
            clearFile();
        }
        
    } catch (error) {
        console.error('Error:', error);
        contentDiv.textContent = `Error: ${error.message || 'Failed to get response. Please try again.'}`;
        messageDiv.className = 'message error';
    } finally {
        // Re-enable input
        chatInput.disabled = false;
        sendButton.disabled = false;
        fileButton.disabled = false;
        chatInput.focus();
    }
}

// Original send message function (fallback for non-streaming)
async function sendMessage() {
    const message = chatInput.value.trim();
    if (!message && !selectedFile) return;
    
    // Disable input while sending
    chatInput.disabled = true;
    sendButton.disabled = true;
    fileButton.disabled = true;
    
    // Add user message
    if (message) {
        addMessage(message + (selectedFile ? ` [Attached: ${selectedFile.name}]` : ''), true);
    } else if (selectedFile) {
        addMessage(`[Attached: ${selectedFile.name}]`, true);
    }
    
    // Clear input
    chatInput.value = '';
    
    // Show typing indicator
    const typingIndicator = showTypingIndicator();
    
    try {
        // Get selected agent
        const agentId = agentSelect.value;
        
        // Log what we're sending
        console.log('[Client] Sending message:', message);
        console.log('[Client] Using agent:', agentId);
        console.log('[Client] Has file:', !!selectedFile);
        
        let response;
        
        if (selectedFile) {
            // Send with file using FormData
            const formData = new FormData();
            formData.append('message', message || '');
            formData.append('agentId', agentId);
            formData.append('file', selectedFile);
            
            response = await fetch('/chat', {
                method: 'POST',
                body: formData
            });
            
            // Clear file after sending
            clearFile();
        } else {
            // Send without file (existing behavior)
            response = await fetch('/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    message: message,
                    agentId: agentId
                })
            });
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[Client] Response received:', data);
        
        // Display agent communication logs if present
        if (data.agentLogs && data.agentLogs.length > 0) {
            console.log('%c=== Agent Communication Logs ===', 'color: #2196F3; font-size: 14px; font-weight: bold');
            data.agentLogs.forEach(log => {
                const timestamp = new Date(log.timestamp).toLocaleTimeString();
                
                if (log.message.includes('[Agent Coordination]')) {
                    console.log(`%c${timestamp} - ${log.message}`, 'color: #4CAF50; font-weight: bold');
                } else if (log.message.includes('[Azure Direct]')) {
                    console.log(`%c${timestamp} - ${log.message}`, 'color: #9C27B0');
                } else if (log.message.includes('Research Agent')) {
                    console.log(`%c${timestamp} - ${log.message}`, 'color: #FF5722; font-weight: bold');
                } else if (log.message.includes('Assistant Agent')) {
                    console.log(`%c${timestamp} - ${log.message}`, 'color: #FF9800; font-weight: bold');
                } else if (log.message.includes('Weather Agent')) {
                    console.log(`%c${timestamp} - ${log.message}`, 'color: #00BCD4; font-weight: bold');
                } else {
                    console.log(`${timestamp} - ${log.message}`);
                }
            });
            console.log('%c================================', 'color: #2196F3; font-size: 14px; font-weight: bold');
        }
        
        // Remove typing indicator
        typingIndicator.remove();
        
        // Add assistant response
        if (data.choices && data.choices[0] && data.choices[0].message) {
            console.log('[Client] Assistant response:', data.choices[0].message.content);
            addMessage(data.choices[0].message.content);
        } else {
            console.error('[Client] Invalid response format:', data);
            throw new Error('Invalid response format');
        }
        
    } catch (error) {
        // Remove typing indicator
        typingIndicator.remove();
        
        // Show error message
        console.error('Error:', error);
        addMessage(`Error: ${error.message || 'Failed to get response. Please try again.'}`, false, true);
    } finally {
        // Re-enable input
        chatInput.disabled = false;
        sendButton.disabled = false;
        fileButton.disabled = false;
        chatInput.focus();
    }
}

// Check if we should use streaming (default to true)
let useStreaming = true;

// Event listeners - use streaming by default
sendButton.addEventListener('click', () => {
    if (useStreaming) {
        sendMessageStream();
    } else {
        sendMessage();
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (useStreaming) {
            sendMessageStream();
        } else {
            sendMessage();
        }
    }
});

// Focus input on load
window.addEventListener('load', () => {
    chatInput.focus();
});

// Handle agent selection change
agentSelect.addEventListener('change', () => {
    const agentName = agentSelect.options[agentSelect.selectedIndex].text;
    addMessage(`Switched to ${agentName} agent. How can I help you?`);
});

// File handling functions
function selectFile(file) {
    if (file && (file.type === 'application/pdf' || file.type === 'text/plain' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
        selectedFile = file;
        fileName.textContent = file.name;
        filePreview.style.display = 'block';
        fileButton.classList.add('has-file');
    } else {
        alert('Please select a PDF, TXT, or DOCX file');
    }
}

function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    filePreview.style.display = 'none';
    fileButton.classList.remove('has-file');
}

// File event listeners
fileButton.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        selectFile(file);
    }
});

removeFileButton.addEventListener('click', clearFile);

// Drag and drop support
chatMessages.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatMessages.style.backgroundColor = '#f0f0f0';
});

chatMessages.addEventListener('dragleave', (e) => {
    e.preventDefault();
    chatMessages.style.backgroundColor = '';
});

chatMessages.addEventListener('drop', (e) => {
    e.preventDefault();
    chatMessages.style.backgroundColor = '';
    
    const file = e.dataTransfer.files[0];
    if (file) {
        selectFile(file);
    }
});