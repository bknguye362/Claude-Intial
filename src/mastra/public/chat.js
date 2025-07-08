// Chat functionality
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const agentSelect = document.getElementById('agent-select');

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
    if (!message) return;
    
    // Disable input while sending
    chatInput.disabled = true;
    sendButton.disabled = true;
    
    // Add user message
    addMessage(message, true);
    
    // Clear input
    chatInput.value = '';
    
    // Show typing indicator
    const typingIndicator = showTypingIndicator();
    
    try {
        // Get selected agent
        const agentId = agentSelect.value;
        
        // Send request to API
        const response = await fetch('/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: message,
                agentId: agentId
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Remove typing indicator
        typingIndicator.remove();
        
        // Add assistant response
        if (data.choices && data.choices[0] && data.choices[0].message) {
            addMessage(data.choices[0].message.content);
        } else {
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