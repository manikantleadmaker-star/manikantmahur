document.addEventListener('DOMContentLoaded', () => {

    // ==========================================================================
    // 1. AUTHENTICATION & UI GATE HANDLERS
    // ==========================================================================
    const passwordGate = document.getElementById('password-gate');
    const mainApp = document.getElementById('main-app');
    const gateForm = document.getElementById('gate-form');
    const gatePassword = document.getElementById('gate-password');
    const gateError = document.getElementById('gate-error');
    const gateSubmitBtn = document.getElementById('gate-submit-btn');
    const toggleGatePassword = document.getElementById('toggle-gate-password');
    const logoutBtn = document.getElementById('logout-btn');

    // Check existing session
    if (sessionStorage.getItem('authenticated') === 'true') {
        passwordGate?.classList.add('hidden');
        mainApp?.classList.remove('hidden');
    } else {
        passwordGate?.classList.remove('hidden');
        mainApp?.classList.add('hidden');
    }

    // Toggle password visibility on Gate
    if (toggleGatePassword && gatePassword) {
        toggleGatePassword.addEventListener('click', () => {
            const type = gatePassword.getAttribute('type') === 'password' ? 'text' : 'password';
            gatePassword.setAttribute('type', type);
            toggleGatePassword.innerHTML = type === 'password' 
                ? '<i class="fa-regular fa-eye"></i>' 
                : '<i class="fa-regular fa-eye-slash"></i>';
        });
    }

    // Password Gate Form Submission
    if (gateForm) {
        gateForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = gatePassword.value.trim();
            if (!password) return;

            gateSubmitBtn.disabled = true;
            gateSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
            gateError?.classList.add('hidden');

            try {
                const response = await fetch('/api/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });

                const result = await response.json();

                if (result.success) {
                    sessionStorage.setItem('authenticated', 'true');
                    passwordGate.classList.add('hidden');
                    mainApp.classList.remove('hidden');
                } else {
                    gateError?.classList.remove('hidden');
                    gatePassword.value = '';
                    gatePassword.focus();
                }
            } catch (err) {
                alert('Connection error. Please try again.');
            } finally {
                gateSubmitBtn.disabled = false;
                gateSubmitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Enter';
            }
        });
    }

    // Double-click Logout Handler
    if (logoutBtn) {
        logoutBtn.addEventListener('dblclick', () => {
            sessionStorage.removeItem('authenticated');
            window.location.reload();
        });
    }

    // ==========================================================================
    // 2. CONSOLE FORM & LIVE SSE BATCH MONITOR
    // ==========================================================================
    const dashboardEmail = document.getElementById('dashboard-email');
    const dashboardPassword = document.getElementById('dashboard-password');
    const togglePasswordBtn = document.getElementById('toggle-password');

    const senderName = document.getElementById('sender-name');
    const subject = document.getElementById('subject');
    const messageBody = document.getElementById('message-body');

    const recipientsInput = document.getElementById('recipients-input');
    const detectedCount = document.getElementById('detected-count');
    const emailValidationError = document.getElementById('email-validation-error');

    const statTotal = document.getElementById('stat-total');
    const statSent = document.getElementById('stat-sent');
    const statFailed = document.getElementById('stat-failed');
    const statRemaining = document.getElementById('stat-remaining');
    const progressBar = document.getElementById('progress-bar');
    const statusIcon = document.getElementById('status-icon');
    const statusText = document.getElementById('status-text');

    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');

    let extractedEmails = [];
    let isSending = false;
    let stopRequested = false;

    // Toggle Dashboard App Password Visibility
    if (togglePasswordBtn && dashboardPassword) {
        togglePasswordBtn.addEventListener('click', () => {
            const type = dashboardPassword.getAttribute('type') === 'password' ? 'text' : 'password';
            dashboardPassword.setAttribute('type', type);
            togglePasswordBtn.innerHTML = type === 'password' 
                ? '<i class="fa-regular fa-eye"></i>' 
                : '<i class="fa-regular fa-eye-slash"></i>';
        });
    }

    // Extract & Validate Emails from Textarea
    if (recipientsInput) {
        recipientsInput.addEventListener('input', () => {
            const text = recipientsInput.value;
            if (!text.trim()) {
                extractedEmails = [];
                if (detectedCount) detectedCount.textContent = '0 found';
                return;
            }

            const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
            const matches = text.match(emailRegex) || [];

            // Deduplicate and trim email list
            extractedEmails = [...new Set(matches.map(e => e.toLowerCase().trim()))];

            if (detectedCount) detectedCount.textContent = `${extractedEmails.length} found`;
            if (extractedEmails.length > 0 && emailValidationError) {
                emailValidationError.classList.add('hidden');
            }
        });
    }

    // UI Helper Functions
    function startSendingUI(total) {
        isSending = true;
        stopRequested = false;
        if (statTotal) statTotal.textContent = total;
        if (statSent) statSent.textContent = '0';
        if (statFailed) statFailed.textContent = '0';
        if (statRemaining) statRemaining.textContent = total;
        if (progressBar) progressBar.style.width = '0%';

        if (statusIcon) statusIcon.className = 'fa-solid fa-circle-notch fa-spin text-primary';
        if (statusText) statusText.textContent = 'Sending emails in batches of 8...';

        sendBtn?.classList.add('hidden');
        stopBtn?.classList.remove('hidden');
        if (stopBtn) stopBtn.disabled = false;
    }

    function updateProgressUI(sentCount, failedCount, total, customText) {
        if (statSent) statSent.textContent = sentCount;
        if (statFailed) statFailed.textContent = failedCount;

        const remaining = Math.max(0, total - (sentCount + failedCount));
        if (statRemaining) statRemaining.textContent = remaining;

        const percentage = Math.min(100, Math.round(((sentCount + failedCount) / total) * 100));
        if (progressBar) progressBar.style.width = `${percentage}%`;

        if (customText && statusText && isSending && !stopRequested) {
            statusText.textContent = customText;
        }
    }

    function finishSendingUI() {
        sendBtn?.classList.remove('hidden');
        stopBtn?.classList.add('hidden');
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send All';
        }
    }

    // Main Dispatch Event
    if (sendBtn) {
        sendBtn.addEventListener('click', async () => {
            if (isSending) return;

            const emailVal = dashboardEmail.value.trim();
            const appPasswordVal = dashboardPassword.value.replace(/\s+/g, '').trim();
            const senderNameVal = senderName.value.trim();
            const subjectVal = subject.value.trim();
            const messageBodyVal = messageBody.value.trim();

            if (!emailVal || !appPasswordVal || !senderNameVal || !subjectVal || !messageBodyVal) {
                return alert('Please fill in all input fields.');
            }
            if (extractedEmails.length === 0) {
                emailValidationError?.classList.remove('hidden');
                return alert('Please enter valid recipient emails.');
            }

            const recipientsToSend = [...extractedEmails];
            const turnstileResponse = document.querySelector('[name="cf-turnstile-response"]')?.value || "";

            sendBtn.disabled = true;
            sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

            try {
                // Step 1: Verify SMTP Auth
                const verifyRes = await fetch('/api/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: emailVal, appPassword: appPasswordVal, cfToken: turnstileResponse })
                });

                const verifyResult = await verifyRes.json();
                if (!verifyResult.success) {
                    alert(verifyResult.message || 'SMTP Verification failed.');
                    finishSendingUI();
                    return;
                }

                // Step 2: Initialize UI
                startSendingUI(recipientsToSend.length);

                let sentCount = 0;
                let failedCount = 0;

                // Step 3: Stream SSE Batch Process
                const response = await fetch('/api/send-stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: emailVal,
                        appPassword: appPasswordVal,
                        senderName: senderNameVal,
                        subject: subjectVal,
                        messageBody: messageBodyVal,
                        recipients: recipientsToSend,
                        cfToken: turnstileResponse
                    })
                });

                if (!response.ok) throw new Error('Streaming connection failed.');

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    if (stopRequested) break;

                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop(); // Retain incomplete chunk in buffer

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const dataStr = trimmedLine.replace('data: ', '').trim();
                            if (dataStr === '[DONE]') break;

                            try {
                                const event = JSON.parse(dataStr);
                                if (event.success) {
                                    sentCount++;
                                    updateProgressUI(sentCount, failedCount, recipientsToSend.length, `Sent: ${event.recipient}`);
                                } else if (event.recipient) {
                                    failedCount++;
                                    updateProgressUI(sentCount, failedCount, recipientsToSend.length, `Failed: ${event.recipient}`);
                                }
                            } catch (e) {
                                // Ignore keep-alive comments or non-JSON chunks
                            }
                        }
                    }
                }

                isSending = false;
                if (stopRequested) {
                    if (statusIcon) statusIcon.className = 'fa-solid fa-circle-stop text-danger';
                    if (statusText) statusText.textContent = 'Process stopped by user.';
                } else {
                    if (statusIcon) statusIcon.className = 'fa-solid fa-circle-check text-success';
                    if (statusText) statusText.textContent = 'Completed!';
                    alert(`Process Finished!\nSent: ${sentCount}\nFailed: ${failedCount}`);
                }

            } catch (err) {
                console.error(err);
                alert('Connection error occurred during transmission.');
            } finally {
                isSending = false;
                finishSendingUI();
            }
        });
    }

    // Stop Sending Execution
    if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
            stopRequested = true;
            if (statusIcon) statusIcon.className = 'fa-solid fa-spinner fa-spin text-warning';
            if (statusText) statusText.textContent = 'Stopping send process...';
            stopBtn.disabled = true;

            try {
                await fetch('/api/stop', { method: 'POST' });
            } catch (e) {
                console.error("Stop error:", e);
            }
        });
    }
});
