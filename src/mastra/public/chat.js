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

// Send message to API
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

// Event listeners
sendButton.addEventListener('click', sendMessage);

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
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
    if (file && file.type === 'application/pdf') {
        selectedFile = file;
        fileName.textContent = file.name;
        filePreview.style.display = 'block';
        fileButton.classList.add('has-file');
    } else {
        alert('Please select a PDF file');
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