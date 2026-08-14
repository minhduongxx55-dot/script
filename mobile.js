// ==UserScript==
// @name         Zefoy OXY Suite v0.0.31 (fix comments countdown + mobile optimized)
// @namespace    http://tampermonkey.net/
// @version      0.0.31
// @description  Sửa Buff Comments Hearts: ưu tiên countdown, bắt .views-countdown. Tối ưu cho mobile.
// @author       OXY
// @match        *://zefoy.com/*
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // =============================================
    // 1. CẤU HÌNH & BIẾN TOÀN CỤC (giữ nguyên)
    // =============================================
    const CONFIG = {
        MAX_ATTEMPTS: 3,
        OCR_CONFIDENCE_THRESHOLD: 50,
        POLLING_INTERVAL: 3000,
        RETRY_DELAY: 500,
        TIKWM_API: 'https://www.tikwm.com/api/',
        DEBOUNCE_DELAY: 600,
        TIKTOK_POLLING_INTERVAL: 10000,
        FAV_WAIT_TIMEOUT: 30000,
        FAV_WAIT_INTERVAL: 500,
        CHEARTS_WAIT_TIMEOUT: 30000,
        CHEARTS_WAIT_INTERVAL: 500,
    };

    let state = {
        solving: false,
        solved: false,
        submitCounter: 0,
        lastSrc: '',
        dashboardReady: false,
        tiktokTimeout: null,
        pollingTimer: null,
        pollingActive: true,
        isFetching: false,
        lastFetchedUrl: '',
        lastResultHtml: '',
        lastVideoData: null,
        firstFetchDone: false,
        buffRunning: false,
        buffStop: false,
        buffPhase: 0,
        favRunning: false,
        favStop: false,
        favPhase: 0,
        cheartsRunning: false,
        cheartsStop: false,
        cheartsPhase: 0,
    };

    // =============================================
    // 2. LOG (giữ nguyên)
    // =============================================
    function log(msg, type = 'info') {
        const time = new Date().toLocaleTimeString();
        const prefix = `[${time}] [OXY]`;
        if (type === 'error') console.error(prefix, msg);
        else if (type === 'warn') console.warn(prefix, msg);
        else if (type === 'debug') console.debug(prefix, msg);
        else console.log(prefix, msg);

        if (state.dashboardReady) {
            const logArea = document.getElementById('oxy-dashboard-log');
            if (!logArea) return;
            const colors = {
                info: '#00bfff',
                success: '#00ff7f',
                error: '#ff4444',
                warn: '#ffcc00',
                debug: '#aaaaaa'
            };
            const div = document.createElement('div');
            div.style.color = colors[type] || '#ffffff';
            div.textContent = `[${time}] ${msg}`;
            logArea.appendChild(div);
            logArea.scrollTop = logArea.scrollHeight;
        }
    }

    // =============================================
    // 3. CAPTCHA + OCR (giữ nguyên)
    // =============================================
    function getElements() {
        const img = document.getElementById('captcha-img');
        const input = document.querySelector('input[name="captchalogin"]');
        const encoded = document.getElementById('captchaencoded');
        const submitBtn = document.querySelector('.submit-captcha');
        const refreshBtn = document.querySelector('.refresh-capthca-btn-new');
        const form = document.querySelector('form');
        return { img, input, encoded, submitBtn, refreshBtn, form };
    }

    function imageToPngDataUrl(img) {
        if (!img.naturalWidth || !img.naturalHeight) {
            throw new Error('Ảnh chưa giải mã hoặc kích thước 0');
        }
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Không tạo được canvas context');
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length < 100) {
            throw new Error('PNG data URL không hợp lệ');
        }
        return dataUrl;
    }

    async function ocrImage(imgElement) {
        try {
            const pngData = imageToPngDataUrl(imgElement);
            log(`📸 PNG data length=${pngData.length}`, 'debug');
            log('🔍 Đang OCR...', 'info');
            const result = await Tesseract.recognize(
                pngData,
                'eng',
                {
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            log(`OCR ${Math.round(m.progress * 100)}%`, 'debug');
                        }
                    }
                }
            );
            let text = result.data.text.replace(/[^a-z]/gi, '').toLowerCase();
            const conf = Math.round(result.data.confidence || 0);
            log(`📝 OCR: "${text}" (conf: ${conf}%)`, 'info');
            return { text, confidence: conf };
        } catch (e) {
            const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            log('❌ Lỗi OCR: ' + detail, 'error');
            if (e.stack) log(e.stack, 'error');
            return { text: '', confidence: 0 };
        }
    }

    function waitForNewImage(oldSrc, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const img = document.getElementById('captcha-img');
                if (!img) {
                    log('ℹ️ Không còn ảnh captcha trong DOM', 'info');
                    resolve(true);
                    return;
                }
                const currentSrc = img.currentSrc || img.src || '';
                const w = img.naturalWidth || 0;
                const h = img.naturalHeight || 0;
                if (currentSrc !== oldSrc && w > 0 && h > 0) {
                    log(`✅ Ảnh mới load: ${currentSrc.substring(0, 60)}`, 'info');
                    resolve(true);
                    return;
                }
                if (Date.now() - start > timeout) {
                    reject(new Error('Timeout đợi ảnh mới'));
                    return;
                }
                if (currentSrc !== oldSrc) {
                    img.addEventListener('load', () => {
                        log('✅ Event load ảnh mới', 'debug');
                        resolve(true);
                    }, { once: true });
                    img.addEventListener('error', () => {
                        reject(new Error('Ảnh mới load thất bại'));
                    }, { once: true });
                    return;
                }
                setTimeout(check, 300);
            };
            check();
        });
    }

    async function solveCaptcha() {
        if (state.solved) {
            log('✅ Đã giải thành công, bỏ qua', 'info');
            return;
        }
        if (state.solving) {
            log('⏳ Đang chạy, bỏ qua gọi trùng', 'warn');
            return;
        }
        if (state.submitCounter >= CONFIG.MAX_ATTEMPTS) {
            log(`❌ Đã thử submit ${CONFIG.MAX_ATTEMPTS} lần thất bại, dừng`, 'error');
            return;
        }

        state.solving = true;
        log(`🚀 Bắt đầu giải (lần submit #${state.submitCounter + 1})`, 'info');

        try {
            const { img, input, encoded, submitBtn, refreshBtn, form } = getElements();
            if (!img || !input || !encoded || !submitBtn || !form) {
                log('Đéo Có Captcha', 'error');
                state.solving = false;
                return;
            }

            if (!img.complete || !img.naturalWidth) {
                log('⏳ Đợi ảnh load...', 'debug');
                try {
                    await new Promise((resolve, reject) => {
                        img.addEventListener('load', resolve, { once: true });
                        img.addEventListener('error', () => reject(new Error('Tải ảnh thất bại')), { once: true });
                    });
                    log('✅ Ảnh đã load', 'info');
                } catch (e) {
                    log('❌ Lỗi tải ảnh: ' + e.message, 'error');
                    state.solving = false;
                    return;
                }
            }

            const oldSrc = img.currentSrc || img.src || '';

            const { text, confidence } = await ocrImage(img);
            if (text.length < 2) {
                log('⚠️ OCR không ra chữ hoặc quá ngắn', 'warn');
                if (refreshBtn) {
                    refreshBtn.click();
                    try {
                        await waitForNewImage(oldSrc);
                        state.solving = false;
                        await solveCaptcha();
                        return;
                    } catch (err) {
                        log('❌ Lỗi đợi ảnh mới: ' + err.message, 'error');
                    }
                }
                state.solving = false;
                return;
            }

            if (confidence < CONFIG.OCR_CONFIDENCE_THRESHOLD) {
                log(`⚠️ Confidence thấp (${confidence}%), thử refresh`, 'warn');
                if (refreshBtn) {
                    refreshBtn.click();
                    try {
                        await waitForNewImage(oldSrc);
                        state.solving = false;
                        await solveCaptcha();
                        return;
                    } catch (err) {
                        log('❌ Lỗi đợi ảnh mới: ' + err.message, 'error');
                    }
                }
                state.solving = false;
                return;
            }

            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            log(`✏️ Điền "${text}"`, 'info');

            if (!form.checkValidity()) {
                log('❌ Form không hợp lệ', 'error');
                form.reportValidity();
                state.solving = false;
                return;
            }

            state.submitCounter++;
            log(`📤 Submit lần #${state.submitCounter}/${CONFIG.MAX_ATTEMPTS}...`, 'info');
            form.requestSubmit(submitBtn);

        } catch (e) {
            log('💥 Lỗi không mong muốn: ' + (e.message || e), 'error');
            if (e.stack) log(e.stack, 'error');
        } finally {
            state.solving = false;
            log('🏁 Kết thúc lần giải', 'debug');
        }
    }

    function initObserver() {
        const observer = new MutationObserver(function(mutations) {
            let captchaChanged = false;
            for (let mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                    const target = mutation.target;
                    if (target && target.id === 'captcha-img') {
                        captchaChanged = true;
                        break;
                    }
                }
                if (mutation.type === 'childList') {
                    for (let node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            const img = node.querySelector ? node.querySelector('#captcha-img') : null;
                            if (img || (node.id === 'captcha-img')) {
                                captchaChanged = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (captchaChanged) {
                const img = document.getElementById('captcha-img');
                if (img) {
                    const currentSrc = img.currentSrc || img.src || '';
                    if (currentSrc !== state.lastSrc) {
                        log('📡 Phát hiện captcha mới (observer)', 'info');
                        state.lastSrc = currentSrc;
                        if (state.submitCounter < CONFIG.MAX_ATTEMPTS && !state.solving && !state.solved) {
                            setTimeout(() => solveCaptcha(), CONFIG.RETRY_DELAY);
                        } else {
                            log(`⏹️ Không giải: đạt giới hạn hoặc đang chạy (submitCounter=${state.submitCounter})`, 'warn');
                        }
                    }
                }
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
        });
        log('🔭 MutationObserver đã kích hoạt', 'info');
    }

    function initPolling() {
        setInterval(() => {
            const img = document.getElementById('captcha-img');
            if (!img) return;
            const currentSrc = img.currentSrc || img.src || '';
            if (currentSrc && currentSrc !== state.lastSrc && !state.solved) {
                log('📡 Phát hiện captcha mới (polling)', 'info');
                state.lastSrc = currentSrc;
                if (state.submitCounter < CONFIG.MAX_ATTEMPTS && !state.solving) {
                    setTimeout(() => solveCaptcha(), CONFIG.RETRY_DELAY);
                } else {
                    log(`⏹️ Polling: đạt giới hạn hoặc đang chạy (submitCounter=${state.submitCounter})`, 'warn');
                }
            }
        }, CONFIG.POLLING_INTERVAL);
    }

    // =============================================
    // 4. TIKTOK INSPECTOR (giữ nguyên)
    // =============================================
    function isValidTikTokUrl(url) {
        if (!url || typeof url !== 'string') return false;
        const trimmed = url.trim();
        const patterns = [
            /^https?:\/\/(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/i,
            /^https?:\/\/(www\.)?tiktok\.com\/[\w.-]+\/video\/\d+/i,
            /^https?:\/\/vm\.tiktok\.com\/[a-zA-Z0-9]+\/?/i,
            /^https?:\/\/vt\.tiktok\.com\/[a-zA-Z0-9]+\/?/i,
        ];
        return patterns.some(p => p.test(trimmed));
    }

    async function inspectTikTok(url, silent = false) {
        if (!silent) {
            log(`📥 Đang lấy thông tin video: ${url}`, 'info');
        }
        try {
            const apiUrl = `${CONFIG.TIKWM_API}?url=${encodeURIComponent(url)}`;
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.code !== 0 || !data.data) {
                log('❌ Lỗi API: ' + (data.msg || 'Không lấy được dữ liệu'), 'error');
                return null;
            }

            const info = data.data;
            const videoInfo = {
                id: info.id || 'N/A',
                author: info.author?.unique_id || info.author?.nickname || 'N/A',
                authorName: info.author?.nickname || 'N/A',
                description: info.title || 'Không có mô tả',
                views: info.play_count || 0,
                likes: info.digg_count || 0,
                comments: info.comment_count || 0,
                shares: info.share_count || 0,
                favorites: info.collect_count || 0,
                duration: info.duration || 0,
                createTime: info.create_time || 'Không rõ',
                coverUrl: info.cover || '',
                videoUrl: info.play || '',
                music: info.music_info?.title || 'Không có',
                durationText: formatDuration(info.duration || 0),
            };
            return videoInfo;
        } catch (e) {
            log('❌ Lỗi kết nối API: ' + e.message, 'error');
            return null;
        }
    }

    function formatDuration(seconds) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function renderTikTokResult(video) {
        if (!video) {
            return '<div style="color:#ff4444;padding:8px;background:rgba(255,0,0,0.1);border-radius:6px;">❌ Không lấy được thông tin. Kiểm tra URL hoặc thử lại.</div>';
        }

        return `
            <div style="background:rgba(0,0,0,0.7);border-radius:8px;padding:12px;margin-top:8px;border:1px solid #00ff7f;">
                <div style="display:flex;gap:12px;flex-wrap:wrap;">
                    ${video.coverUrl ? `<img src="${video.coverUrl}" style="max-width:160px;max-height:200px;border-radius:8px;border:1px solid #333;flex-shrink:0;" />` : ''}
                    <div style="flex:1;min-width:200px;">
                        <div style="color:#00ff7f;font-weight:bold;font-size:16px;">${video.author}</div>
                        <div style="color:#aaa;font-size:13px;margin:4px 0;">@${video.authorName}</div>
                        <div style="color:#fff;font-size:13px;margin:6px 0;max-height:60px;overflow:hidden;">${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}</div>
                        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:4px;margin-top:6px;">
                            <span style="color:#00bfff;">👁️ ${video.views.toLocaleString()}</span>
                            <span style="color:#ff6b6b;">❤️ ${video.likes.toLocaleString()}</span>
                            <span style="color:#ffd93d;">💬 ${video.comments.toLocaleString()}</span>
                            <span style="color:#6bcb77;">↗️ ${video.shares.toLocaleString()}</span>
                            <span style="color:#ff85a1;">⭐ ${video.favorites.toLocaleString()}</span>
                            <span style="color:#a66cff;">⏱️ ${video.durationText}</span>
                        </div>
                        <div style="color:#aaa;font-size:11px;margin-top:6px;">🆔 ${video.id}  •  📅 ${video.createTime}</div>
                        ${video.videoUrl ? `<div style="margin-top:6px;"><a href="${video.videoUrl}" target="_blank" style="color:#00bfff;text-decoration:none;">▶ Xem video</a></div>` : ''}
                        ${video.music && video.music !== 'Không có' ? `<div style="color:#aaa;font-size:12px;margin-top:4px;">🎵 ${video.music}</div>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    async function fetchAndUpdate(url, resultDiv, isPollingCall = false) {
        if (state.isFetching) return;
        state.isFetching = true;
        try {
            const video = await inspectTikTok(url, isPollingCall);
            if (video) {
                const newHtml = renderTikTokResult(video);
                if (resultDiv.innerHTML !== newHtml) {
                    resultDiv.innerHTML = newHtml;
                    state.lastResultHtml = newHtml;
                    if (isPollingCall && state.firstFetchDone) {
                        const old = state.lastVideoData;
                        if (old) {
                            const viewsChanged = old.views !== video.views;
                            const likesChanged = old.likes !== video.likes;
                            if (viewsChanged || likesChanged) {
                                log(`🔄 Cập nhật: ${video.author} - 👁️ ${video.views.toLocaleString()} ❤️ ${video.likes.toLocaleString()}`, 'success');
                            }
                        }
                    }
                    state.lastVideoData = video;
                }
                state.lastFetchedUrl = url;
                if (!state.firstFetchDone) {
                    state.firstFetchDone = true;
                    log(`✅ Đã lấy video: ${video.author} (${video.id})`, 'success');
                }
            } else {
                if (!resultDiv.innerHTML.includes('Không lấy được')) {
                    resultDiv.innerHTML = '<div style="color:#ff4444;padding:8px;background:rgba(255,0,0,0.1);border-radius:6px;">❌ Không lấy được thông tin. Kiểm tra URL hoặc thử lại.</div>';
                }
                log('❌ Lấy thông tin video thất bại', 'error');
            }
        } catch (e) {
            // bỏ qua
        } finally {
            state.isFetching = false;
        }
    }

    function startTikTokPolling() {
        if (state.pollingTimer) return;
        state.pollingActive = true;
        state.pollingTimer = setInterval(() => {
            if (!state.pollingActive) return;
            const urlInput = document.getElementById('oxy-tiktok-url');
            const resultDiv = document.getElementById('oxy-tiktok-result');
            if (!urlInput || !resultDiv) return;
            const url = urlInput.value.trim();
            if (!isValidTikTokUrl(url)) return;
            if (state.isFetching) return;
            fetchAndUpdate(url, resultDiv, true);
        }, CONFIG.TIKTOK_POLLING_INTERVAL);
        log('🔄 TikTok polling đã bắt đầu (10s, silent mode)', 'info');
    }

    function stopTikTokPolling() {
        if (state.pollingTimer) {
            clearInterval(state.pollingTimer);
            state.pollingTimer = null;
            state.pollingActive = false;
            log('⏸️ TikTok polling đã dừng', 'info');
        }
    }

    function toggleTikTokPolling() {
        if (state.pollingTimer) {
            stopTikTokPolling();
            document.getElementById('oxy-polling-status').innerHTML = '⏸️ Auto-refresh: OFF';
            document.getElementById('oxy-toggle-polling').textContent = '▶️ Bật';
        } else {
            state.pollingActive = true;
            startTikTokPolling();
            document.getElementById('oxy-polling-status').innerHTML = '🔄 Auto-refresh: 10s';
            document.getElementById('oxy-toggle-polling').textContent = '⏸️ Tạm dừng';
        }
    }

    function setupTikTokAutoInspector(urlInput, resultDiv) {
        const newInput = urlInput.cloneNode(true);
        urlInput.parentNode.replaceChild(newInput, urlInput);

        newInput.addEventListener('input', function() {
            clearTimeout(state.tiktokTimeout);
            const url = this.value.trim();
            const resDiv = document.getElementById('oxy-tiktok-result');
            if (!resDiv) return;
            resDiv.innerHTML = '';

            if (!url) {
                resDiv.innerHTML = '<div style="color:#aaa;padding:4px;">📌 Nhập link TikTok để xem thông tin...</div>';
                state.firstFetchDone = false;
                state.lastVideoData = null;
                return;
            }

            if (!isValidTikTokUrl(url)) {
                resDiv.innerHTML = '<div style="color:#ffcc00;padding:4px;">⚠️ Link không hợp lệ. Cần link video TikTok</div>';
                return;
            }

            resDiv.innerHTML = '<div style="color:#aaa;padding:4px;">⏳ Đang lấy thông tin...</div>';

            state.tiktokTimeout = setTimeout(async () => {
                await fetchAndUpdate(url, resDiv, false);
                if (!state.pollingTimer && state.pollingActive) {
                    startTikTokPolling();
                }
            }, CONFIG.DEBOUNCE_DELAY);
        });

        newInput.addEventListener('paste', function() {
            setTimeout(() => {
                this.dispatchEvent(new Event('input'));
            }, 50);
        });

        if (newInput.value.trim()) {
            newInput.dispatchEvent(new Event('input'));
        } else {
            const resDiv = document.getElementById('oxy-tiktok-result');
            if (resDiv) {
                resDiv.innerHTML = '<div style="color:#aaa;padding:4px;">📌 Nhập link TikTok để xem thông tin...</div>';
            }
        }

        if (!state.pollingTimer && state.pollingActive) {
            startTikTokPolling();
        }
    }

    // =============================================
    // 5. BUFF VIEWS (giữ nguyên)
    // =============================================
    function checkBuffStatus() {
        const viewsCard = document.querySelector('.t-views-button')?.closest('.card');
        if (!viewsCard) {
            return { status: 'unknown', message: 'Không tìm thấy card Views' };
        }
        const badge = viewsCard.querySelector('small.badge');
        if (!badge) {
            return { status: 'unknown', message: 'Không tìm thấy badge' };
        }
        const text = badge.textContent.trim().toLowerCase();
        if (text.includes('soon will be update') || text.includes('soon')) {
            return { status: 'locked', message: '🔒 Bị khóa (soon will be update)' };
        } else {
            return { status: 'ready', message: '✅ Sẵn Sàng' };
        }
    }

    function waitForElement(selector, timeout = 10000, interval = 300) {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                const el = document.querySelector(selector);
                if (el) { resolve(el); return; }
                if (Date.now() - start > timeout) { resolve(null); return; }
                setTimeout(check, interval);
            };
            check();
        });
    }

    function parseCountdown(text) {
        const minuteMatch = text.match(/(\d+)\s*minute/);
        const secondMatch = text.match(/(\d+)\s*second/);
        let minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
        let seconds = secondMatch ? parseInt(secondMatch[1]) : 0;
        return (minutes * 60 + seconds) * 1000;
    }

    async function performBuffViews(url, isSetup = false) {
        log(`🔄 ${isSetup ? 'Setup' : 'Lặp'} buff views...`, 'info');

        const viewBtn = document.querySelector('button.btn.btn-primary.rounded-0.t-views-button');
        if (viewBtn) {
            viewBtn.click();
            log('✅ Click nút chọn views', 'success');
        } else {
            log('❌ Không tìm thấy nút t-views-button', 'error');
            return false;
        }

        const viewsForm = await waitForElement('.t-views-menu form', 5000);
        if (!viewsForm) {
            log('❌ Không tìm thấy form Views', 'error');
            return false;
        }

        const viewsRoot = document.querySelector('.t-views-menu');
        if (!viewsRoot) {
            log('❌ Không tìm thấy .t-views-menu', 'error');
            return false;
        }

        const input = viewsForm.querySelector('input[type="search"][placeholder="Enter Video URL"]');
        const searchBtn = viewsForm.querySelector('button[type="submit"].disableButton');

        if (!input || !searchBtn) {
            log('❌ Form Views thiếu input hoặc search', 'error');
            return false;
        }

        input.focus();
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        log(`✅ Đã điền URL: "${input.value}"`, 'success');

        if (!viewsForm.checkValidity()) {
            viewsForm.reportValidity();
            log('❌ Form Views không hợp lệ', 'error');
            return false;
        }

        log('📤 Submit Search lần đầu...', 'info');
        viewsForm.requestSubmit(searchBtn);

        await new Promise(r => setTimeout(r, 2000));

        const loginCountdown = document.querySelector('#login-countdown');
        if (loginCountdown) {
            const text = loginCountdown.textContent.trim();
            if (text.includes('Please wait') && text.includes('before trying again')) {
                const delay = parseCountdown(text);
                log(`⏳ Đợi ${delay/1000}s trước khi search lại...`, 'warn');
                await new Promise(r => setTimeout(r, delay + 1000));
                viewsForm.requestSubmit(searchBtn);
                log('✅ Search lại', 'success');
                await new Promise(r => setTimeout(r, 2000));
            } else if (text.includes('READY')) {
                log('✅ READY, search lại ngay', 'success');
                viewsForm.requestSubmit(searchBtn);
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        const buffBtn = viewsRoot.querySelector('button.wbutton.btn.btn-dark.rounded-0.font-weight-bold.p-2');
        if (buffBtn) {
            const icon = buffBtn.querySelector('i.fa-video-camera');
            if (icon) {
                buffBtn.click();
                log('✅ Click nút Buff Views!', 'success');
                return true;
            } else {
                log('⚠️ Nút buff không có icon, vẫn click', 'warn');
                buffBtn.click();
                return true;
            }
        } else {
            const altBtn = viewsRoot.querySelector('button i.fa-video-camera')?.closest('button');
            if (altBtn) {
                altBtn.click();
                log('✅ Click nút Buff (qua icon)', 'success');
                return true;
            }
            log('❌ Không tìm thấy nút Buff Views trong .t-views-menu', 'error');
            return false;
        }
    }

    async function startBuffViews() {
        if (state.buffRunning) { log('⚠️ Buff Views đang chạy', 'warn'); return; }
        const status = checkBuffStatus();
        if (status.status === 'locked') {
            log(`❌ Views bị khóa: ${status.message}`, 'error');
            document.getElementById('oxy-buff-status').innerHTML = '🔒 Bị khóa';
            return;
        } else {
            log(`✅ Trạng thái Views: ${status.message}`, 'success');
            document.getElementById('oxy-buff-status').innerHTML = '✅ Sẵn Sàng';
        }
        const urlInput = document.getElementById('oxy-tiktok-url');
        if (!urlInput) { log('❌ Không tìm thấy ô nhập URL', 'error'); return; }
        const url = urlInput.value.trim();
        if (!isValidTikTokUrl(url)) { log('❌ URL không hợp lệ', 'error'); return; }

        state.buffRunning = true;
        state.buffStop = false;
        state.buffPhase = 0;
        document.getElementById('oxy-buff-start').style.display = 'none';
        document.getElementById('oxy-buff-stop').style.display = 'inline-block';
        document.getElementById('oxy-buff-status').innerHTML = '🔄 Đang chạy...';
        log('🚀 Bắt đầu Buff Views', 'success');

        try {
            log('📌 Lần 0 - Setup', 'info');
            const success = await performBuffViews(url, true);
            if (!success) { log('❌ Setup thất bại, dừng', 'error'); state.buffRunning = false; return; }
            state.buffPhase = 1;
            while (!state.buffStop) {
                log(`📌 Lần ${state.buffPhase} - Lặp`, 'info');
                const heartsEl = document.querySelector('.hearts-countdown');
                if (heartsEl) {
                    const text = heartsEl.textContent.trim();
                    if (text.includes('Please wait') && text.includes('for your next submit')) {
                        const delay = parseCountdown(text);
                        log(`⏳ Lần ${state.buffPhase}: đợi ${delay/1000}s...`, 'warn');
                        await new Promise(r => setTimeout(r, delay + 1000));
                    }
                }
                const loopSuccess = await performBuffViews(url, false);
                if (!loopSuccess) log(`❌ Lần ${state.buffPhase} thất bại`, 'error');
                else log(`✅ Lần ${state.buffPhase} thành công`, 'success');
                state.buffPhase++;
                if (state.buffStop) break;
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            log('💥 Lỗi buff: ' + e.message, 'error');
        } finally {
            state.buffRunning = false;
            document.getElementById('oxy-buff-start').style.display = 'inline-block';
            document.getElementById('oxy-buff-stop').style.display = 'none';
            document.getElementById('oxy-buff-status').innerHTML = '⏹ Đã dừng';
            log('⏹ Buff Views đã dừng', 'info');
        }
    }

    function stopBuffViews() {
        if (!state.buffRunning) { log('⚠️ Buff Views không chạy', 'warn'); return; }
        state.buffStop = true;
        log('⏹ Yêu cầu dừng Buff Views...', 'info');
        document.getElementById('oxy-buff-status').innerHTML = '⏳ Đang dừng...';
    }

    // =============================================
    // 6. BUFF FAVORITES (giữ nguyên)
    // =============================================
    function checkFavStatus() {
        const favCard = document.querySelector('.t-favorites-button')?.closest('.card');
        if (!favCard) {
            return { status: 'unknown', message: 'Không tìm thấy card Favorites' };
        }
        const badge = favCard.querySelector('small.badge');
        if (!badge) {
            return { status: 'unknown', message: 'Không tìm thấy badge' };
        }
        const text = badge.textContent.trim().toLowerCase();
        if (text.includes('soon will be update') || text.includes('soon')) {
            return { status: 'locked', message: '🔒 Bị khóa (soon will be update)' };
        } else {
            return { status: 'ready', message: '✅ Sẵn Sàng' };
        }
    }

    function getFavoritesState(favRoot) {
        if (!favRoot) return 'unknown';

        const errorEl = favRoot.querySelector('.error');
        if (errorEl) {
            const style = getComputedStyle(errorEl);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                return 'error';
            }
        }

        const bookmark = favRoot.querySelector('i.fa-bookmark');
        const select = favRoot.querySelector('select[name="select_lmt"]');
        if (bookmark && select) {
            return 'ready';
        }

        const countdown = favRoot.querySelector('.hearts-countdown, #login-countdown');
        if (countdown) {
            const text = countdown.textContent.trim();
            if (text.includes('Please wait') && (text.includes('second') || text.includes('minute'))) {
                return 'waiting';
            }
        }

        const spinner = favRoot.querySelector('.spinner-border');
        if (spinner) {
            const style = getComputedStyle(spinner);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                return 'pending';
            }
        }

        return 'pending';
    }

    function waitForFavoritesState(favRoot, timeout = CONFIG.FAV_WAIT_TIMEOUT, interval = CONFIG.FAV_WAIT_INTERVAL) {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                const state = getFavoritesState(favRoot);
                if (state !== 'pending' && state !== 'unknown') {
                    resolve(state);
                    return;
                }
                if (Date.now() - start > timeout) {
                    resolve('timeout');
                    return;
                }
                setTimeout(check, interval);
            };
            check();
        });
    }

    async function performFavoritesSearch(favForm, url) {
        const input = favForm.querySelector('input[type="search"][placeholder="Enter Video URL"]');
        const searchBtn = favForm.querySelector('button[type="submit"].disableButton');

        if (!input || !searchBtn) {
            log('❌ Form Favorites thiếu input hoặc search', 'error');
            return null;
        }

        input.focus();
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        log(`✅ Đã điền URL: "${input.value}"`, 'success');

        if (!favForm.checkValidity()) {
            favForm.reportValidity();
            log('❌ Form Favorites không hợp lệ', 'error');
            return null;
        }

        log('📤 Submit Search...', 'info');
        favForm.requestSubmit(searchBtn);
        return true;
    }

    async function performBuffFavorites(url, limit, isSetup = false) {
        log(`🔄 ${isSetup ? 'Setup' : 'Lặp'} buff favorites...`, 'info');

        const favBtn = document.querySelector('button.btn.btn-primary.rounded-0.t-favorites-button');
        if (favBtn) {
            favBtn.click();
            log('✅ Click nút chọn favorites', 'success');
        } else {
            log('❌ Không tìm thấy nút t-favorites-button', 'error');
            return false;
        }

        const favForm = await waitForElement('.t-favorites-menu form', 5000);
        if (!favForm) {
            log('❌ Không tìm thấy form Favorites', 'error');
            return false;
        }

        const favRoot = document.querySelector('.t-favorites-menu');
        if (!favRoot) {
            log('❌ Không tìm thấy .t-favorites-menu', 'error');
            return false;
        }

        const searchResult = await performFavoritesSearch(favForm, url);
        if (searchResult === null) return false;

        log('⏳ Đợi phản hồi từ server...', 'info');
        const state = await waitForFavoritesState(favRoot, CONFIG.FAV_WAIT_TIMEOUT);

        if (state === 'timeout') {
            log('❌ Timeout chờ phản hồi Favorites', 'error');
            return false;
        }

        if (state === 'error') {
            const errorEl = favRoot.querySelector('.error');
            log(`❌ Lỗi từ server: "${errorEl ? errorEl.textContent.trim() : 'unknown error'}"`, 'error');
            return false;
        }

        if (state === 'waiting') {
            const countdown = favRoot.querySelector('.hearts-countdown, #login-countdown');
            if (countdown) {
                const text = countdown.textContent.trim();
                log(`📌 Countdown: "${text}"`, 'info');
                const delay = parseCountdown(text);
                if (delay > 0) {
                    log(`⏳ Đợi ${delay/1000}s trước khi search lại...`, 'warn');
                    await new Promise(r => setTimeout(r, delay + 1000));
                    return await performBuffFavorites(url, limit, false);
                }
            }
            log('⚠️ Đang ở trạng thái waiting nhưng không parse được countdown, thử lại', 'warn');
            return false;
        }

        if (state === 'ready') {
            const bookmark = favRoot.querySelector('i.fa-bookmark');
            const buffBtn = bookmark ? bookmark.closest('button.wbutton.btn.btn-dark.rounded-0.font-weight-bold.p-2') : null;
            if (!buffBtn) {
                log('❌ Không tìm thấy nút Buff Favorites', 'error');
                return false;
            }

            const actionForm = buffBtn.form;
            if (!actionForm) {
                log('❌ Nút Buff không nằm trong form', 'error');
                return false;
            }

            const selectEl = actionForm.querySelector('select[name="select_lmt"]');
            if (!selectEl) {
                log('❌ Form action thiếu select_lmt', 'error');
                return false;
            }

            selectEl.value = String(limit);
            selectEl.dispatchEvent(new Event('input', { bubbles: true }));
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            log(`✅ Đã chọn limit: ${selectEl.value} (thực tế)`, 'success');

            let submitOccurred = false;
            actionForm.addEventListener('submit', function(event) {
                submitOccurred = true;
                log(`📤 Submit event: trusted=${event.isTrusted}, prevented=${event.defaultPrevented}`, 'info');
            }, { capture: true, once: true });

            log('ℹ️ Gọi actionForm.requestSubmit(buffBtn)', 'info');
            try {
                actionForm.requestSubmit(buffBtn);
            } catch (e) {
                log('❌ Lỗi khi requestSubmit: ' + e.message, 'error');
                return false;
            }

            await new Promise(r => setTimeout(r, 1000));

            if (!submitOccurred) {
                log('⚠️ requestSubmit không kích hoạt submit, thử form.submit()', 'warn');
                actionForm.submit();
                await new Promise(r => setTimeout(r, 1000));
            }

            const errorEl = favRoot.querySelector('.error');
            if (errorEl) {
                const style = getComputedStyle(errorEl);
                const errorVisible = style.display !== 'none' && style.visibility !== 'hidden';
                if (errorVisible) {
                    log(`❌ Lỗi hiển thị: "${errorEl.textContent.trim()}"`, 'error');
                    return false;
                }
            }

            log('✅ Buff Favorites hoàn tất (không có lỗi hiển thị)', 'success');
            return true;
        }

        log(`⚠️ Trạng thái không xác định: ${state}`, 'warn');
        return false;
    }

    async function startBuffFavorites() {
        if (state.favRunning) { log('⚠️ Buff Favorites đang chạy', 'warn'); return; }
        const status = checkFavStatus();
        if (status.status === 'locked') {
            log(`❌ Favorites bị khóa: ${status.message}`, 'error');
            document.getElementById('oxy-fav-status').innerHTML = '🔒 Bị khóa';
            return;
        } else {
            log(`✅ Trạng thái Favorites: ${status.message}`, 'success');
            document.getElementById('oxy-fav-status').innerHTML = '✅ Sẵn Sàng';
        }
        const urlInput = document.getElementById('oxy-tiktok-url');
        if (!urlInput) { log('❌ Không tìm thấy ô nhập URL', 'error'); return; }
        const url = urlInput.value.trim();
        if (!isValidTikTokUrl(url)) { log('❌ URL không hợp lệ', 'error'); return; }

        const limitSelect = document.getElementById('oxy-fav-limit');
        const limit = limitSelect ? parseInt(limitSelect.value) : 100;

        state.favRunning = true;
        state.favStop = false;
        state.favPhase = 0;
        document.getElementById('oxy-fav-start').style.display = 'none';
        document.getElementById('oxy-fav-stop').style.display = 'inline-block';
        document.getElementById('oxy-fav-status').innerHTML = '🔄 Đang chạy...';
        log('🚀 Bắt đầu Buff Favorites', 'success');

        try {
            log('📌 Lần 0 - Setup', 'info');
            const success = await performBuffFavorites(url, limit, true);
            if (!success) { log('❌ Setup thất bại, dừng', 'error'); state.favRunning = false; return; }
            state.favPhase = 1;

            while (!state.favStop) {
                log(`📌 Lần ${state.favPhase} - Lặp`, 'info');
                const heartsEl = document.querySelector('.hearts-countdown');
                if (heartsEl) {
                    const text = heartsEl.textContent.trim();
                    if (text.includes('Please wait') && text.includes('for your next submit')) {
                        const delay = parseCountdown(text);
                        log(`⏳ Lần ${state.favPhase}: đợi ${delay/1000}s...`, 'warn');
                        await new Promise(r => setTimeout(r, delay + 1000));
                    }
                }
                const loopSuccess = await performBuffFavorites(url, limit, false);
                if (!loopSuccess) log(`❌ Lần ${state.favPhase} thất bại`, 'error');
                else log(`✅ Lần ${state.favPhase} thành công`, 'success');
                state.favPhase++;
                if (state.favStop) break;
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            log('💥 Lỗi buff favorites: ' + e.message, 'error');
        } finally {
            state.favRunning = false;
            document.getElementById('oxy-fav-start').style.display = 'inline-block';
            document.getElementById('oxy-fav-stop').style.display = 'none';
            document.getElementById('oxy-fav-status').innerHTML = '⏹ Đã dừng';
            log('⏹ Buff Favorites đã dừng', 'info');
        }
    }

    function stopBuffFavorites() {
        if (!state.favRunning) { log('⚠️ Buff Favorites không chạy', 'warn'); return; }
        state.favStop = true;
        log('⏹ Yêu cầu dừng Buff Favorites...', 'info');
        document.getElementById('oxy-fav-status').innerHTML = '⏳ Đang dừng...';
    }

    // =============================================
    // 7. BUFF COMMENTS HEARTS – SỬA COUNTDOWN (giữ nguyên)
    // =============================================
    function checkCheartsStatus() {
        const cheartsCard = document.querySelector('.t-chearts-button')?.closest('.card');
        if (!cheartsCard) {
            return { status: 'unknown', message: 'Không tìm thấy card Comments Hearts' };
        }
        const badge = cheartsCard.querySelector('small.badge');
        if (!badge) {
            return { status: 'unknown', message: 'Không tìm thấy badge' };
        }
        const text = badge.textContent.trim().toLowerCase();
        if (text.includes('soon will be update') || text.includes('soon')) {
            return { status: 'locked', message: '🔒 Bị khóa (soon will be update)' };
        } else {
            return { status: 'ready', message: '✅ Sẵn Sàng' };
        }
    }

    function normalizeUsername(value) {
        return String(value ?? '')
            .normalize('NFKC')
            .trim()
            .replace(/^@+/, '')
            .toLowerCase();
    }

    function findCommentByUsername(cheartsRoot, username) {
        if (!cheartsRoot || !username) return null;

        const items = cheartsRoot.querySelectorAll('ul.list-group li.list-group-item');
        const targetUsername = normalizeUsername(username);

        for (const item of items) {
            const usernameEl = item.querySelector('.kadi-rengi');
            if (!usernameEl) continue;

            const commentUsername = normalizeUsername(usernameEl.textContent);
            log(
                `🔍 So sánh username: DOM="${commentUsername}", target="${targetUsername}"`,
                'debug'
            );

            if (commentUsername === targetUsername) {
                return item.closest('form');
            }
        }

        return null;
    }

    function getCheartsCountdown(cheartsRoot) {
        const el = cheartsRoot?.querySelector(
            '.views-countdown, .hearts-countdown, #login-countdown'
        );

        if (!el) return null;

        const style = getComputedStyle(el);
        const visible =
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            el.getClientRects().length > 0;

        return visible ? el : null;
    }

    function getCheartsState(cheartsRoot) {
        if (!cheartsRoot) return 'unknown';

        const errorEl = cheartsRoot.querySelector('.error');
        if (errorEl) {
            const style = getComputedStyle(errorEl);
            if (style.display !== 'none' && style.visibility !== 'hidden' && errorEl.getClientRects().length > 0) {
                return 'error';
            }
        }

        const countdown = getCheartsCountdown(cheartsRoot);
        if (countdown) {
            const text = countdown.textContent.trim();
            if (/please wait/i.test(text) && /(second|minute)/i.test(text)) {
                return 'waiting';
            }
        }

        const listItems = cheartsRoot.querySelectorAll('ul.list-group li.list-group-item');
        if (listItems.length > 0) {
            return 'has_comments';
        }

        const commentsIcon = cheartsRoot.querySelector('button.wbutton[type="submit"] i.fa-comments');
        if (commentsIcon && commentsIcon.closest('button')) {
            return 'comments_button_ready';
        }

        return 'pending';
    }

    function waitForCheartsState(cheartsRoot, timeout = CONFIG.CHEARTS_WAIT_TIMEOUT, interval = CONFIG.CHEARTS_WAIT_INTERVAL) {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                const state = getCheartsState(cheartsRoot);
                if (state !== 'pending' && state !== 'unknown') {
                    resolve(state);
                    return;
                }
                if (Date.now() - start > timeout) {
                    resolve('timeout');
                    return;
                }
                setTimeout(check, interval);
            };
            check();
        });
    }

    async function performCheartsSearch(cheartsForm, url) {
        const input = cheartsForm.querySelector('input[type="search"][placeholder="Enter Video URL"]');
        const searchBtn = cheartsForm.querySelector('button[type="submit"].disableButton');

        if (!input || !searchBtn) {
            log('❌ Form Comments Hearts thiếu input hoặc search', 'error');
            return null;
        }

        input.focus();
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        log(`✅ Đã điền URL: "${input.value}"`, 'success');

        if (!cheartsForm.checkValidity()) {
            cheartsForm.reportValidity();
            log('❌ Form Comments Hearts không hợp lệ', 'error');
            return null;
        }

        log('📤 Submit Search Comments Hearts...', 'info');
        cheartsForm.requestSubmit(searchBtn);
        return true;
    }

    async function performBuffChearts(url, username, limit, isSetup = false) {
        log(`🔄 ${isSetup ? 'Setup' : 'Lặp'} buff comments hearts...`, 'info');

        const cheartsBtn = document.querySelector('button.btn.btn-primary.rounded-0.t-chearts-button');
        if (cheartsBtn) {
            cheartsBtn.click();
            log('✅ Click nút chọn comments hearts', 'success');
        } else {
            log('❌ Không tìm thấy nút t-chearts-button', 'error');
            return false;
        }

        const cheartsForm = await waitForElement('.t-chearts-menu form', 5000);
        if (!cheartsForm) {
            log('❌ Không tìm thấy form Comments Hearts', 'error');
            return false;
        }

        const cheartsRoot = document.querySelector('.t-chearts-menu');
        if (!cheartsRoot) {
            log('❌ Không tìm thấy .t-chearts-menu', 'error');
            return false;
        }

        const searchResult = await performCheartsSearch(cheartsForm, url);
        if (searchResult === null) return false;

        log('⏳ Đợi phản hồi Comments Hearts...', 'info');
        let state = await waitForCheartsState(cheartsRoot, CONFIG.CHEARTS_WAIT_TIMEOUT);

        if (state === 'timeout') {
            log('❌ Timeout chờ phản hồi Comments Hearts', 'error');
            return false;
        }

        if (state === 'error') {
            const errorEl = cheartsRoot.querySelector('.error');
            log(`❌ Lỗi từ server: "${errorEl ? errorEl.textContent.trim() : 'unknown error'}"`, 'error');
            return false;
        }

        if (state === 'waiting') {
            const countdown = getCheartsCountdown(cheartsRoot);
            if (countdown) {
                const text = countdown.textContent.trim();
                log(`📌 Countdown: "${text}"`, 'info');
                const delay = parseCountdown(text);
                if (delay > 0) {
                    log(`⏳ Đợi ${delay/1000}s trước khi search lại...`, 'warn');
                    await new Promise(r => setTimeout(r, delay + 1000));
                    return await performBuffChearts(url, username, limit, false);
                }
            }
            log('⚠️ Đang ở trạng thái waiting nhưng không parse được countdown, thử lại', 'warn');
            return false;
        }

        // Giai đoạn 1: Nút comments
        if (state === 'comments_button_ready') {
            const commentsBtn = cheartsRoot.querySelector('button.wbutton[type="submit"] i.fa-comments')?.closest('button');
            if (!commentsBtn) {
                log('❌ Không tìm thấy nút comments', 'error');
                return false;
            }
            log(`✅ Đã nhận phản hồi Comments Hearts: "${commentsBtn.textContent.trim()}"`, 'success');

            const commentsForm = commentsBtn.form || commentsBtn.closest('form');
            if (!commentsForm) {
                log('❌ Nút comments không thuộc form nào', 'error');
                return false;
            }

            log(
                `🔍 Trạng thái nút: connected=${commentsBtn.isConnected}, ` +
                `disabled=${commentsBtn.disabled}, ` +
                `hasForm=${Boolean(commentsBtn.form)}, ` +
                `valid=${commentsForm.checkValidity()}`,
                'info'
            );

            let submitOccurred = false;
            commentsForm.addEventListener('submit', event => {
                submitOccurred = true;
                log(
                    `📌 Submit event: trusted=${event.isTrusted}, ` +
                    `prevented=${event.defaultPrevented}`,
                    'info'
                );
            }, { capture: true, once: true });

            log('ℹ️ Gọi commentsForm.requestSubmit(commentsBtn)', 'info');
            try {
                commentsForm.requestSubmit(commentsBtn);
            } catch (e) {
                log('❌ Lỗi requestSubmit: ' + e.message, 'error');
                log('ℹ️ Thử commentsForm.submit()', 'warn');
                commentsForm.submit();
            }

            await new Promise(r => setTimeout(r, 500));

            if (!submitOccurred) {
                log('❌ requestSubmit/submit không kích hoạt submit event', 'error');
                return false;
            }

            log('✅ Submit event đã được phát', 'success');

            const commentsWaitStart = Date.now();
            while (state === 'comments_button_ready' || state === 'pending') {
                await new Promise(r => setTimeout(r, 500));
                state = getCheartsState(cheartsRoot);
                if (state === 'has_comments') break;
                if (state === 'error') break;
                if (Date.now() - commentsWaitStart > CONFIG.CHEARTS_WAIT_TIMEOUT) {
                    state = 'timeout';
                    break;
                }
            }
            if (state === 'timeout') {
                log('❌ Timeout chờ danh sách comment', 'error');
                return false;
            }
            if (state === 'error') {
                const errorEl = cheartsRoot.querySelector('.error');
                log(`❌ Lỗi từ server khi lấy danh sách: "${errorEl ? errorEl.textContent.trim() : 'unknown error'}"`, 'error');
                return false;
            }
        }

        // Giai đoạn 2: Danh sách comment
        if (state === 'has_comments') {
            const commentForm = findCommentByUsername(cheartsRoot, username);
            if (!commentForm) {
                log(`❌ Không tìm thấy comment của username: "${username}"`, 'error');
                const items = cheartsRoot.querySelectorAll('ul.list-group li.list-group-item');
                const usernames = [];
                for (let item of items) {
                    const el = item.querySelector('.kadi-rengi');
                    if (el) usernames.push(el.textContent.trim());
                }
                log(`📌 Username có trong list: ${usernames.join(', ')}`, 'info');
                return false;
            }

            const selectEl = commentForm.querySelector('select[name="select_lmt"]');
            if (!selectEl) {
                log('❌ Form comment thiếu select_lmt', 'error');
                return false;
            }

            selectEl.value = String(limit);
            selectEl.dispatchEvent(new Event('input', { bubbles: true }));
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            log(`✅ Đã chọn limit: ${selectEl.value} (thực tế)`, 'success');

            let submitOccurred = false;
            commentForm.addEventListener('submit', function(event) {
                submitOccurred = true;
                log(`📤 Submit heart event: trusted=${event.isTrusted}, prevented=${event.defaultPrevented}`, 'info');
            }, { capture: true, once: true });

            let heartBtn = commentForm.querySelector('button.wbutton.btn.btn-primary.rounded-0.font-weight-bold.p-2');
            if (!heartBtn) {
                const heartIcon = commentForm.querySelector('i.fa-heart');
                if (heartIcon) {
                    const fallbackBtn = heartIcon.closest('button');
                    if (fallbackBtn) {
                        log('⚠️ Tìm thấy nút heart qua icon fallback', 'warn');
                        heartBtn = fallbackBtn;
                    }
                }
            }

            if (!heartBtn) {
                log('❌ Không tìm thấy nút heart trong comment form', 'error');
                return false;
            }

            log('ℹ️ Gọi commentForm.requestSubmit(heartBtn)', 'info');
            try {
                commentForm.requestSubmit(heartBtn);
            } catch (e) {
                log('❌ Lỗi requestSubmit heart: ' + e.message, 'error');
                commentForm.submit();
            }

            await new Promise(r => setTimeout(r, 1000));

            if (!submitOccurred) {
                log('⚠️ Không có submit event cho heart, nhưng có thể đã submit', 'warn');
            }

            const errorEl = cheartsRoot.querySelector('.error');
            if (errorEl) {
                const style = getComputedStyle(errorEl);
                const errorVisible = style.display !== 'none' && style.visibility !== 'hidden';
                if (errorVisible) {
                    log(`❌ Lỗi hiển thị: "${errorEl.textContent.trim()}"`, 'error');
                    return false;
                }
            }

            log(`✅ Buff heart cho @${username} hoàn tất!`, 'success');
            return true;
        }

        log(`⚠️ Trạng thái không xác định: ${state}`, 'warn');
        return false;
    }

    async function startBuffChearts() {
        if (state.cheartsRunning) { log('⚠️ Buff Comments Hearts đang chạy', 'warn'); return; }
        const status = checkCheartsStatus();
        if (status.status === 'locked') {
            log(`❌ Comments Hearts bị khóa: ${status.message}`, 'error');
            document.getElementById('oxy-chearts-status').innerHTML = '🔒 Bị khóa';
            return;
        } else {
            log(`✅ Trạng thái Comments Hearts: ${status.message}`, 'success');
            document.getElementById('oxy-chearts-status').innerHTML = '✅ Sẵn Sàng';
        }

        const urlInput = document.getElementById('oxy-tiktok-url');
        if (!urlInput) { log('❌ Không tìm thấy ô nhập URL', 'error'); return; }
        const url = urlInput.value.trim();
        if (!isValidTikTokUrl(url)) { log('❌ URL không hợp lệ', 'error'); return; }

        const usernameInput = document.getElementById('oxy-chearts-username');
        const username = usernameInput ? usernameInput.value.trim() : '';
        if (!username) {
            log('❌ Vui lòng nhập username cần buff heart', 'error');
            return;
        }

        const limitSelect = document.getElementById('oxy-chearts-limit');
        const limit = limitSelect ? parseInt(limitSelect.value) : 25;

        state.cheartsRunning = true;
        state.cheartsStop = false;
        state.cheartsPhase = 0;
        document.getElementById('oxy-chearts-start').style.display = 'none';
        document.getElementById('oxy-chearts-stop').style.display = 'inline-block';
        document.getElementById('oxy-chearts-status').innerHTML = '🔄 Đang chạy...';
        log('🚀 Bắt đầu Buff Comments Hearts', 'success');

        try {
            log('📌 Lần 0 - Setup', 'info');
            const success = await performBuffChearts(url, username, limit, true);
            if (!success) { log('❌ Setup thất bại, dừng', 'error'); state.cheartsRunning = false; return; }
            state.cheartsPhase = 1;

            while (!state.cheartsStop) {
                log(`📌 Lần ${state.cheartsPhase} - Lặp`, 'info');

                const cheartsRoot = document.querySelector('.t-chearts-menu');
                if (cheartsRoot) {
                    const countdown = getCheartsCountdown(cheartsRoot);
                    if (countdown) {
                        const text = countdown.textContent.trim();
                        if (/please wait/i.test(text) && /(second|minute)/i.test(text)) {
                            const delay = parseCountdown(text);
                            if (delay > 0) {
                                log(`⏳ Lần ${state.cheartsPhase}: đợi ${delay/1000}s do countdown...`, 'warn');
                                await new Promise(r => setTimeout(r, delay + 1000));
                            }
                        }
                    }
                }

                const loopSuccess = await performBuffChearts(url, username, limit, false);
                if (!loopSuccess) log(`❌ Lần ${state.cheartsPhase} thất bại`, 'error');
                else log(`✅ Lần ${state.cheartsPhase} thành công`, 'success');
                state.cheartsPhase++;
                if (state.cheartsStop) break;
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            log('💥 Lỗi buff comments hearts: ' + e.message, 'error');
        } finally {
            state.cheartsRunning = false;
            document.getElementById('oxy-chearts-start').style.display = 'inline-block';
            document.getElementById('oxy-chearts-stop').style.display = 'none';
            document.getElementById('oxy-chearts-status').innerHTML = '⏹ Đã dừng';
            log('⏹ Buff Comments Hearts đã dừng', 'info');
        }
    }

    function stopBuffChearts() {
        if (!state.cheartsRunning) { log('⚠️ Buff Comments Hearts không chạy', 'warn'); return; }
        state.cheartsStop = true;
        log('⏹ Yêu cầu dừng Buff Comments Hearts...', 'info');
        document.getElementById('oxy-chearts-status').innerHTML = '⏳ Đang dừng...';
    }

    // =============================================
    // 8. GIAO DIỆN UI (đã thêm CSS responsive)
    // =============================================
    function injectRainbowCSS() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes rainbow-border {
                0% { border-color: #ff0000; box-shadow: 0 0 15px #ff0000; }
                16% { border-color: #ff8800; box-shadow: 0 0 15px #ff8800; }
                33% { border-color: #ffff00; box-shadow: 0 0 15px #ffff00; }
                50% { border-color: #00ff00; box-shadow: 0 0 15px #00ff00; }
                66% { border-color: #0088ff; box-shadow: 0 0 15px #0088ff; }
                83% { border-color: #8800ff; box-shadow: 0 0 15px #8800ff; }
                100% { border-color: #ff0000; box-shadow: 0 0 15px #ff0000; }
            }
            @keyframes rainbow-bg {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }
            @keyframes led-blink {
                0% { opacity: 1; }
                50% { opacity: 0.4; }
                100% { opacity: 1; }
            }
            @keyframes rainbow-text {
                0% { color: #ff0000; }
                16% { color: #ff8800; }
                33% { color: #ffff00; }
                50% { color: #00ff00; }
                66% { color: #0088ff; }
                83% { color: #8800ff; }
                100% { color: #ff0000; }
            }
            .oxy-led {
                animation: led-blink 1.2s ease-in-out infinite;
                display: inline-block;
                padding: 0 4px;
            }
            .oxy-rainbow-border {
                border: 3px solid transparent;
                animation: rainbow-border 3s linear infinite;
                box-shadow: 0 0 20px rgba(255,0,0,0.3);
            }
            .oxy-rainbow-bg {
                background: linear-gradient(270deg, #ff0000, #ff8800, #ffff00, #00ff00, #0088ff, #8800ff, #ff0000);
                background-size: 400% 400%;
                animation: rainbow-bg 6s ease infinite;
                padding: 12px;
                border-radius: 16px;
                margin-top: 8px;
            }
            .oxy-card {
                background: rgba(0,0,0,0.6);
                backdrop-filter: blur(6px);
                border-radius: 12px;
                padding: 12px;
                margin-top: 8px;
                border: 1px solid rgba(255,255,255,0.1);
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            }
            .oxy-card-title {
                color: #00ff7f;
                font-weight: bold;
                font-size: 15px;
                margin-bottom: 6px;
                display: flex;
                align-items: center;
                gap: 6px;
                text-shadow: 0 0 10px rgba(0,255,127,0.3);
            }
            #oxy-dashboard-log {
                background: #0a0a0a;
                color: #0f0;
                font-family: 'Courier New', monospace;
                font-size: 12px;
                padding: 8px;
                border-radius: 8px;
                max-height: 180px;
                overflow-y: auto;
                border: 1px solid #333;
                margin-top: 4px;
                background: rgba(0,0,0,0.85);
            }
            #oxy-dashboard-log::-webkit-scrollbar {
                width: 6px;
            }
            #oxy-dashboard-log::-webkit-scrollbar-track {
                background: #111;
            }
            #oxy-dashboard-log::-webkit-scrollbar-thumb {
                background: #0f0;
                border-radius: 4px;
            }
            .oxy-dashboard-title {
                color: #fff;
                font-weight: bold;
                text-shadow: 0 0 10px rgba(255,255,255,0.5);
                margin-bottom: 4px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .oxy-dashboard-title span {
                font-size: 16px;
            }
            .oxy-clear-log {
                background: #333;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 2px 10px;
                cursor: pointer;
                font-size: 11px;
            }
            .oxy-clear-log:hover {
                background: #555;
            }
            .oxy-tiktok-input {
                width: 100%;
                padding: 8px 12px;
                border-radius: 6px;
                border: 1px solid #555;
                background: #1a1a1a;
                color: #fff;
                font-size: 13px;
                font-family: 'Courier New', monospace;
                margin-top: 4px;
                box-sizing: border-box;
                transition: border-color 0.3s, box-shadow 0.3s;
            }
            .oxy-tiktok-input:focus {
                border-color: #00ff7f;
                outline: none;
                box-shadow: 0 0 15px rgba(0,255,127,0.25);
            }
            .oxy-tiktok-input::placeholder {
                color: #666;
                font-style: italic;
            }
            .oxy-polling-controls {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 4px;
                font-size: 11px;
            }
            #oxy-polling-status {
                color: #aaa;
            }
            #oxy-toggle-polling {
                background: transparent;
                border: 1px solid #555;
                color: #fff;
                border-radius: 4px;
                padding: 2px 10px;
                cursor: pointer;
                font-size: 11px;
                transition: all 0.2s;
            }
            #oxy-toggle-polling:hover {
                background: #333;
                border-color: #00ff7f;
            }
            .oxy-buff-btn {
                background: #ff8800;
                color: #000;
                border: none;
                border-radius: 6px;
                padding: 6px 16px;
                font-weight: bold;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            }
            .oxy-buff-btn:hover {
                background: #ffaa33;
                box-shadow: 0 0 20px rgba(255,136,0,0.4);
            }
            .oxy-buff-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .oxy-buff-stop-btn {
                background: #ff4444;
                color: #fff;
                border: none;
                border-radius: 6px;
                padding: 6px 16px;
                font-weight: bold;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            }
            .oxy-buff-stop-btn:hover {
                background: #ff6666;
            }
            .oxy-buff-status {
                color: #aaa;
                font-size: 12px;
                margin-left: 8px;
            }
            .oxy-flex {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }
            .oxy-tiktok-result {
                margin-top: 6px;
            }
            .oxy-fav-limit {
                background: #1a1a1a;
                color: #fff;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 12px;
            }
            .oxy-fav-limit:focus {
                border-color: #00ff7f;
                outline: none;
            }
            .oxy-chearts-input {
                background: #1a1a1a;
                color: #fff;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 12px;
                width: 120px;
            }
            .oxy-chearts-input:focus {
                border-color: #00ff7f;
                outline: none;
            }
            .oxy-chearts-limit {
                background: #1a1a1a;
                color: #fff;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 12px;
            }
            .oxy-chearts-limit:focus {
                border-color: #00ff7f;
                outline: none;
            }
            .oxy-footer {
                font-size: 16px;
                font-weight: bold;
                padding: 10px 0;
                text-align: center;
                background: transparent;
            }
            .oxy-footer .rainbow-text {
                animation: rainbow-text 3s linear infinite;
                display: inline-block;
            }
            .oxy-footer .led-red {
                color: #ff0000;
                animation: led-blink 1.2s ease-in-out infinite;
                display: inline-block;
                padding: 0 6px;
            }
            .oxy-footer .led-pink {
                color: #ff00ff;
                animation: led-blink 1.5s ease-in-out infinite;
                display: inline-block;
                padding: 0 6px;
            }

            /* ========== RESPONSIVE CHO MOBILE ========== */
            @media (max-width: 600px) {
                .oxy-card {
                    padding: 8px !important;
                    margin-top: 6px !important;
                }
                .oxy-tiktok-input {
                    font-size: 16px !important; /* tránh zoom trên iOS */
                    padding: 10px 12px !important;
                }
                .oxy-buff-btn, .oxy-buff-stop-btn {
                    font-size: 14px !important;
                    padding: 10px 16px !important;
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                .oxy-flex {
                    flex-direction: column !important;
                    align-items: stretch !important;
                    gap: 6px !important;
                }
                .oxy-chearts-input, .oxy-fav-limit, .oxy-chearts-limit {
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                #oxy-dashboard-log {
                    max-height: 120px !important;
                    font-size: 11px !important;
                }
                .oxy-dashboard-title {
                    font-size: 14px !important;
                }
                .oxy-polling-controls {
                    font-size: 12px !important;
                    flex-wrap: wrap !important;
                }
                .oxy-card-title {
                    font-size: 14px !important;
                }
                .oxy-footer {
                    font-size: 14px !important;
                }
                .oxy-rainbow-bg {
                    padding: 8px !important;
                }
                .oxy-buff-status {
                    font-size: 12px !important;
                    margin-left: 0 !important;
                }
                #oxy-toggle-polling {
                    padding: 4px 12px !important;
                    font-size: 12px !important;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function modifyFooter() {
        const footer = document.querySelector('footer.d-flex.justify-content-center.text-muted');
        if (footer) {
            footer.className = 'oxy-footer d-flex justify-content-center';
            footer.innerHTML = `
                <span class="led-red">●</span>
                <span class="rainbow-text">Địt mẹ Zefoy by Chungdeptrai</span>
                <span class="led-pink">●</span>
            `;
            log('✅ Footer đã được sửa thành chữ rainbow + LED', 'success');
        } else {
            log('⚠️ Không tìm thấy footer để sửa', 'warn');
        }
    }

    function modifyUI() {
        log('🎨 Đang tạo giao diện mới...', 'info');

        const targetDiv = document.querySelector('div.col-sm-12.mt-1.h6');
        if (!targetDiv) {
            log('⚠️ Không tìm thấy div target', 'warn');
            return;
        }

        const container = document.createElement('div');
        container.id = 'oxy-dashboard-container';
        container.className = 'oxy-rainbow-bg';

        container.innerHTML = `
            <div class="oxy-dashboard-title">
                <span>🔥 OXY DASHBOARD <span style="font-size:12px;color:#aaa;">v0.0.31</span></span>
                <button class="oxy-clear-log" id="oxy-clear-log-btn">Clear Log</button>
            </div>
            <div class="oxy-card">
                <div class="oxy-card-title"><span class="oxy-led" style="color:#00ff7f;">●</span> System Log</div>
                <div id="oxy-dashboard-log"></div>
            </div>
            <div class="oxy-card">
                <div class="oxy-card-title"><span class="oxy-led" style="color:#ff00ff;">●</span> TikTok Inspector <span style="font-size:12px;color:#888;font-weight:normal;">(tự động lấy info)</span></div>
                <input type="text" id="oxy-tiktok-url" class="oxy-tiktok-input" placeholder="Dán link TikTok bất kỳ... tự động lấy thông tin" />
                <div class="oxy-polling-controls">
                    <span id="oxy-polling-status">🔄 Auto-refresh: 10s</span>
                    <button id="oxy-toggle-polling">⏸️ Tạm dừng</button>
                </div>
                <div id="oxy-tiktok-result" class="oxy-tiktok-result">
                    <div style="color:#aaa;padding:4px;">📌 Nhập link TikTok để xem thông tin...</div>
                </div>
            </div>
            <div class="oxy-card">
                <div class="oxy-card-title"><span class="oxy-led" style="color:#ff8800;">●</span> Buff Views</div>
                <div class="oxy-flex">
                    <button id="oxy-buff-start" class="oxy-buff-btn">▶ Bắt đầu Buff Views</button>
                    <button id="oxy-buff-stop" class="oxy-buff-stop-btn" style="display:none;">⏹ Dừng</button>
                    <span id="oxy-buff-status" class="oxy-buff-status">Trạng thái: ${checkBuffStatus().message}</span>
                </div>
                <div style="margin-top:6px;font-size:11px;color:#888;">
                    ⚡ Sử dụng URL ở ô TikTok Inspector phía trên.
                </div>
            </div>
            <div class="oxy-card">
                <div class="oxy-card-title"><span class="oxy-led" style="color:#ff00ff;">●</span> Buff Favorites</div>
                <div class="oxy-flex">
                    <button id="oxy-fav-start" class="oxy-buff-btn">▶ Bắt đầu Buff Favorites</button>
                    <button id="oxy-fav-stop" class="oxy-buff-stop-btn" style="display:none;">⏹ Dừng</button>
                    <span id="oxy-fav-status" class="oxy-buff-status">Trạng thái: ${checkFavStatus().message}</span>
                    <select id="oxy-fav-limit" class="oxy-fav-limit">
                        <option value="25">25</option>
                        <option value="50">50</option>
                        <option value="75">75</option>
                        <option value="100" selected>100</option>
                    </select>
                </div>
                <div style="margin-top:6px;font-size:11px;color:#888;">
                    ⚡ Sử dụng URL ở ô TikTok Inspector phía trên. Chọn limit rồi bắt đầu.
                </div>
            </div>
            <div class="oxy-card">
                <div class="oxy-card-title"><span class="oxy-led" style="color:#ff6b6b;">●</span> Buff Comments Hearts</div>
                <div class="oxy-flex">
                    <button id="oxy-chearts-start" class="oxy-buff-btn">▶ Bắt đầu Buff Comments Hearts</button>
                    <button id="oxy-chearts-stop" class="oxy-buff-stop-btn" style="display:none;">⏹ Dừng</button>
                    <span id="oxy-chearts-status" class="oxy-buff-status">Trạng thái: ${checkCheartsStatus().message}</span>
                    <input type="text" id="oxy-chearts-username" class="oxy-chearts-input" placeholder="Username cần buff" />
                    <select id="oxy-chearts-limit" class="oxy-chearts-limit">
                        <option value="25" selected>25</option>
                        <option value="50">50</option>
                    </select>
                </div>
                <div style="margin-top:6px;font-size:11px;color:#888;">
                    ⚡ Nhập username muốn buff heart và chọn số lượng (25/50).
                </div>
            </div>
        `;

        targetDiv.innerHTML = '';
        targetDiv.appendChild(container);
        state.dashboardReady = true;

        document.getElementById('oxy-clear-log-btn').addEventListener('click', function() {
            const logArea = document.getElementById('oxy-dashboard-log');
            if (logArea) logArea.innerHTML = '';
            log('Log đã được xóa', 'info');
        });

        const urlInput = document.getElementById('oxy-tiktok-url');
        const resultDiv = document.getElementById('oxy-tiktok-result');
        setupTikTokAutoInspector(urlInput, resultDiv);

        document.getElementById('oxy-toggle-polling').addEventListener('click', toggleTikTokPolling);

        document.getElementById('oxy-buff-start').addEventListener('click', startBuffViews);
        document.getElementById('oxy-buff-stop').addEventListener('click', stopBuffViews);

        document.getElementById('oxy-fav-start').addEventListener('click', startBuffFavorites);
        document.getElementById('oxy-fav-stop').addEventListener('click', stopBuffFavorites);

        document.getElementById('oxy-chearts-start').addEventListener('click', startBuffChearts);
        document.getElementById('oxy-chearts-stop').addEventListener('click', stopBuffChearts);

        modifyFooter();

        setInterval(() => {
            if (!state.buffRunning) {
                const st = checkBuffStatus();
                document.getElementById('oxy-buff-status').innerHTML = `Trạng thái: ${st.message}`;
                document.getElementById('oxy-buff-start').disabled = (st.status === 'locked');
            }
            if (!state.favRunning) {
                const st = checkFavStatus();
                document.getElementById('oxy-fav-status').innerHTML = `Trạng thái: ${st.message}`;
                document.getElementById('oxy-fav-start').disabled = (st.status === 'locked');
            }
            if (!state.cheartsRunning) {
                const st = checkCheartsStatus();
                document.getElementById('oxy-chearts-status').innerHTML = `Trạng thái: ${st.message}`;
                document.getElementById('oxy-chearts-start').disabled = (st.status === 'locked');
            }
        }, 5000);

        log('✅ Giao diện mới đã sẵn sàng!', 'success');
    }

    // =============================================
    // 9. MODIFY NAV (giữ nguyên)
    // =============================================
    function modifyNav() {
        const termsLi = document.querySelector('li.nav-item a[data-target="#TermsModal"]')?.closest('li');
        const privacyLi = document.querySelector('li.nav-item a[data-target="#PrivacyModal"]')?.closest('li');
        if (termsLi) termsLi.remove();
        if (privacyLi) privacyLi.remove();

        const contactLink = document.querySelector('li.nav-item a[data-target="#ContactModal"]');
        if (contactLink) {
            contactLink.removeAttribute('data-toggle');
            contactLink.removeAttribute('data-target');
            contactLink.innerHTML = `
                <span class="oxy-led" style="color: #ff00ff;">●</span>
                <i class="fa fa-envelope"></i> Contact the dev (Chungdeptraivcl)
                <span class="oxy-led" style="color: #00ffff;">●</span>
            `;
            contactLink.addEventListener('click', function(e) {
                e.preventDefault();
                window.open('https://t.me/Chungdacoeim', '_blank');
            });
        }

        const homeLink = document.querySelector('a.nav-link.navbar-brand[href="/"]');
        if (homeLink) {
            homeLink.innerHTML = `
                <span class="oxy-led" style="color: #ff0000;">●</span>
                <i class="fa fa-home"></i> FCKZEFOY
                <span class="oxy-led" style="color: #ff8800;">●</span>
            `;
        }
    }

    // =============================================
    // 10. KHỞI CHẠY
    // =============================================
    function init() {
        log('🔥 OXY Suite v0.0.31 khởi động...', 'info');
        injectRainbowCSS();
        modifyNav();
        modifyUI();
        initObserver();
        initPolling();

        setTimeout(() => {
            const img = document.getElementById('captcha-img');
            if (img) {
                state.lastSrc = img.currentSrc || img.src || '';
            }
            solveCaptcha();
        }, 2000);

        document.addEventListener('click', function(e) {
            if (!e.isTrusted) return;
            const target = e.target;
            if (target && target.classList && target.classList.contains('refresh-capthca-btn-new')) {
                log('🔄 Người dùng bấm refresh – reset trạng thái', 'info');
                state.submitCounter = 0;
                state.solved = false;
                const img = document.getElementById('captcha-img');
                if (img) {
                    const oldSrc = img.currentSrc || img.src || '';
                    state.lastSrc = oldSrc;
                    waitForNewImage(oldSrc).then(() => {
                        setTimeout(() => solveCaptcha(), 500);
                    }).catch(() => {
                        setTimeout(() => solveCaptcha(), 1000);
                    });
                } else {
                    setTimeout(() => solveCaptcha(), 1000);
                }
            }
        });

        log('✅ OXY Suite sẵn sàng!', 'success');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

})();