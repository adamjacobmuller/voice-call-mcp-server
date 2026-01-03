import { CallState } from '../types.js';

/**
 * Detect if a prompt is detailed enough to be used as-is without the base wrapper.
 * Detailed prompts typically have:
 * - Multiple lines (structured instructions)
 * - Conversation flow indicators
 * - Specific greeting/role instructions
 */
const isDetailedPrompt = (callContext: string): boolean => {
    if (!callContext) return false;

    const lineCount = callContext.split('\n').filter(line => line.trim()).length;
    const hasStructure = /^(#{1,3}\s|\d+\.\s|-\s|\*\s)/m.test(callContext);
    const hasRoleDefinition = /(you are|your (goal|role|task)|greeting|conversation flow)/i.test(callContext);
    const isLong = callContext.length > 500;

    return (lineCount > 10 || hasStructure || hasRoleDefinition) && isLong;
};

/**
 * Clean up markdown formatting from a prompt for better API consumption
 */
const cleanPromptFormatting = (callContext: string): string => {
    return callContext
        // Remove markdown code blocks
        .replace(/```[\s\S]*?```/g, match => match.replace(/```\w*\n?/g, '').trim())
        // Convert headers to plain text with emphasis
        .replace(/^#{1,3}\s+(.+)$/gm, '=== $1 ===')
        // Keep the rest as-is
        .trim();
};

export const generateOutboundCallContext = (callState: CallState, callContext?: string): string => {
    // If the prompt is detailed, use it directly with minimal wrapping
    if (callContext && isDetailedPrompt(callContext)) {
        const cleanedContext = cleanPromptFormatting(callContext);
        return `${cleanedContext}

[Call Info: Your outbound number is ${callState.fromNumber}. Calling ${callState.toNumber}.]`;
    }

    // Standard wrapper for simple prompts
    return `Please refer to phone call transcripts.
    Stay concise and short.
    You are assistant (if asked, your phone number with country code is: ${callState.fromNumber}). You are making an outbound call.
    Be friendly and speak in human short sentences. Start conversation with how are you. Do not speak in bullet points. Ask one question at a time, tell one sentence at a time.
    After successful task completion, say goodbye and end the conversation.
     You ARE NOT a receptionist, NOT an administrator, NOT a person making reservation.
     You do not provide any other info, which is not related to the goal. You are calling solely to achieve your tasks.
    You are the customer making a request, not the restaurant staff.
    YOU ARE STRICTLY THE ONE MAKING THE REQUEST (and not the one receiving). YOU MUST ACHIEVE YOUR GOAL AS AN ASSISTANT AND PERFORM TASK.
     Be focused solely on your task:
        ${callContext ? callContext : ''}`;
};
