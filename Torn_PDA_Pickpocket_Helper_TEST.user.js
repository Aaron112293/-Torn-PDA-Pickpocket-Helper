// ==UserScript==
// @name         Aaron's Torn PDA Pickpocket Helper [TEST]
// @namespace    aaron-torn-pda-pickpocket
// @version      1.0.0-test.2
// @description  Manual pickpocket helper with a clearly marked test-only Auto Pick option
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @downloadURL  https://raw.githubusercontent.com/Aaron112293/-Torn-PDA-Pickpocket-Helper/main/Torn_PDA_Pickpocket_Helper_TEST.user.js
// @updateURL    https://raw.githubusercontent.com/Aaron112293/-Torn-PDA-Pickpocket-Helper/main/Torn_PDA_Pickpocket_Helper_TEST.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // All timing values are milliseconds.
    const DEFAULT_SCAN_INTERVAL_MS = 500;
    const RESULT_POLL_MS = 100;
    const RESULT_WAIT_TIMEOUT_MS = 15000;
    const CLOSE_RETRY_MS = 150;
    const CLOSE_TIMEOUT_MS = 4000;
    const AUTO_PICK_MIN_DELAY_MS = 1000;
    const AUTO_PICK_MAX_DELAY_MS = 5000;

    const PANEL_ID = 'aaron-pp-test-panel';
    const MINI_ID = 'aaron-pp-test-mini';
    const PASSWORD_MENU_ID = 'aaron-pp-test-password-menu';
    const BADGE_CLASS = 'aaron-pp-test-badge';
    const ROW_MARK = 'data-aaron-pp-test-row';

    const STORAGE = {
        MODE: 'aaron_pp_v1_mode',
        SCAN: 'aaron_pp_v1_scan',
        MINIMIZED: 'aaron_pp_v1_minimized',
        SKILL_SOURCE: 'aaron_pp_v1_skill_source',
        MANUAL_SKILL: 'aaron_pp_v1_manual_skill',
        LAST_AUTO_SKILL: 'aaron_pp_v1_last_auto_skill',
        ADMIN_HASH: 'aaron_pp_v1_admin_hash',
        ADMIN_SALT: 'aaron_pp_v1_admin_salt',
        ADMIN_ENABLED: 'aaron_pp_v1_admin_enabled',
        SCAN_INTERVAL: 'aaron_pp_v1_scan_interval',
        PAUSE_MINIMIZED: 'aaron_pp_v1_pause_minimized'
    };

    const MODES = ['MAX XP', 'BALANCED', 'SAFEST'];

    // Official Torn Wiki difficulty bands. These are difficulty categories,
    // not skill locks: every target type may appear from crime skill 1.
    const DIFFICULTY_GROUPS = [
        ['Drunk man', 'Drunk woman', 'Homeless person', 'Junkie', 'Elderly man', 'Elderly woman'],
        ['Young man', 'Young woman'],
        ['Businessman', 'Businesswoman', 'Jogger', 'Laborer', 'Postal worker', 'Student', 'Thug'],
        ['Classy lady', 'Cyclist', 'Gang member', 'Rich kid', 'Sex worker'],
        ['Mobster', 'Police officer']
    ];

    const DIFFICULTY_NAMES = ['EASIER', 'LESS DIFFICULT', 'MODERATE', 'MORE DIFFICULT', 'VERY DIFFICULT'];
    const ALL_TARGETS = DIFFICULTY_GROUPS.reduce((list, group) => list.concat(group), []);

    const TARGET_RISK = {
        'Drunk man': 12, 'Drunk woman': 12, 'Homeless person': 15, 'Junkie': 18,
        'Elderly woman': 20, 'Elderly man': 22,
        'Young woman': 30, 'Young man': 33,
        'Postal worker': 45, 'Student': 46, 'Businessman': 48, 'Businesswoman': 48,
        'Jogger': 52, 'Laborer': 52, 'Thug': 58,
        'Classy lady': 65, 'Sex worker': 66, 'Rich kid': 68,
        'Gang member': 75, 'Cyclist': 78,
        'Mobster': 90, 'Police officer': 95
    };

    const BUILD_RISK = {
        'Skinny': -8, 'Average': 0, 'Heavyset': 5, 'Athletic': 10, 'Muscular': 15
    };

    const ACTIVITY_RISK = {
        'Stumbling': -15, 'Distracted': -12, 'Begging': -10, 'Listening to music': -8,
        'On phone': -6, 'Loitering': -5, 'Soliciting': 0, 'Walking': 5,
        'Jogging': 15, 'Cycling': 20, 'Running': 25,
        'Alert': 30, 'Chasing': 35
    };

    // Heuristic only, not a published success percentage. Each CS point after 1
    // removes 0.55 risk-index points. Test diagnostics will be used to calibrate it.
    const SKILL_RISK_RELIEF_PER_POINT = 0.55;

    const BUILD_NAMES = Object.keys(BUILD_RISK);
    const ACTIVITY_NAMES = Object.keys(ACTIVITY_RISK);

    let currentBest = null;
    let actionBusy = false;
    let autoPickEnabled = false;
    let autoPickTimer = null;
    let countdownTimer = null;
    let scanQueued = false;
    let markedRows = new Set();
    let failedAdminAttempts = 0;
    let adminLockedUntil = 0;
    let activeTab = 'main';
    let scanLoopTimer = null;

    function readStorage(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (error) {
            console.warn('[Aaron PP Test] Could not save setting:', key, error);
        }
    }

    function removeStorage(key) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            console.warn('[Aaron PP Test] Could not remove setting:', key, error);
        }
    }

    function getScanInterval() {
        const value = Number(readStorage(STORAGE.SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL_MS));
        return Number.isFinite(value) && value >= 100 && value <= 5000 ? Math.round(value) : DEFAULT_SCAN_INTERVAL_MS;
    }

    function pauseWhenMinimized() {
        return readStorage(STORAGE.PAUSE_MINIMIZED, 'true') !== 'false';
    }

    function restartScanLoop() {
        if (scanLoopTimer) clearInterval(scanLoopTimer);
        scanLoopTimer = setInterval(() => scanTargets(false), getScanInterval());
    }

    function getMode() {
        const saved = readStorage(STORAGE.MODE, 'BALANCED');
        return MODES.includes(saved) ? saved : 'BALANCED';
    }

    function setMode(mode) {
        if (!MODES.includes(mode)) return;
        writeStorage(STORAGE.MODE, mode);
        updateControls();
        scanTargets(true);
    }

    function isScanWanted() {
        return readStorage(STORAGE.SCAN, 'true') !== 'false';
    }

    function setScanWanted(enabled) {
        writeStorage(STORAGE.SCAN, Boolean(enabled));
        if (!enabled) stopAutoPick('Auto Pick stopped');
        updateControls();
        if (enabled) scanTargets(true);
    }

    function isMinimized() {
        return readStorage(STORAGE.MINIMIZED, 'false') === 'true';
    }

    function setMinimized(minimized) {
        writeStorage(STORAGE.MINIMIZED, Boolean(minimized));
        if (minimized) stopAutoPick('Auto Pick paused');
        renderPanelState();
        if (!minimized && isScanWanted()) scanTargets(true);
    }

    function isAdminMode() {
        return readStorage(STORAGE.ADMIN_ENABLED, 'false') === 'true';
    }

    function disableAdminMode() {
        stopAutoPick('Admin Mode disabled');
        writeStorage(STORAGE.ADMIN_ENABLED, false);
        activeTab = 'main';
        updateControls();
    }

    function randomSalt() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join('');
    }

    async function hashPassword(password, salt) {
        const bytes = new TextEncoder().encode(salt + ':' + password);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest))
            .map(value => value.toString(16).padStart(2, '0')).join('');
    }

    function getSkillSource() {
        return readStorage(STORAGE.SKILL_SOURCE, 'AUTO') === 'MANUAL' ? 'MANUAL' : 'AUTO';
    }

    function validSkill(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 1 && number <= 100 ? number : null;
    }

    function visible(element) {
        if (!element || !document.documentElement.contains(element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
            style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    }

    function normalizedText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isPickpocketPage() {
        const href = String(location.href || '').toLowerCase();
        if (href.includes('pickpocketing')) return true;

        if (document.querySelector('.pickpocketing-root, [class*="pickpocketing"], [data-testid*="pickpocket"]')) {
            return true;
        }

        const bodyText = normalizedText(document.body && document.body.innerText);
        const hasTarget = ALL_TARGETS.some(name => bodyText.includes(name));
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'));
        const hasHeading = headings.some(element => normalizedText(element.textContent).toLowerCase() === 'pickpocketing');
        const crimesRoute = href.includes('loader.php') && href.includes('sid=crimes');
        return (hasHeading && (crimesRoute || hasTarget)) || (crimesRoute && hasTarget);
    }

    function pickpocketRoots() {
        const roots = Array.from(document.querySelectorAll(
            '.pickpocketing-root, [class*="pickpocketing"], [data-testid*="pickpocket"]'
        ));
        if (!roots.length) {
            const main = document.querySelector('main, [role="main"]');
            if (main) roots.push(main);
        }
        return roots;
    }

    function detectCrimeSkill() {
        if (!isPickpocketPage()) return null;

        const roots = pickpocketRoots();
        const searchRoots = roots.length ? roots : [document.body];
        const patterns = [
            /pickpocket(?:ing)?\s+(?:crime\s+)?skill\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)/i,
            /crime\s+skill\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)/i,
            /skill\s+level\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)/i,
            /\bCS\s*[:\-]?\s*(\d{1,3}(?:\.\d+)?)/i
        ];

        for (const root of searchRoots) {
            if (!root) continue;
            const text = normalizedText(root.innerText || root.textContent);
            for (const pattern of patterns) {
                const match = text.match(pattern);
                const value = match && validSkill(match[1]);
                if (value !== null) {
                    writeStorage(STORAGE.LAST_AUTO_SKILL, value);
                    return value;
                }
            }

            const labelled = Array.from(root.querySelectorAll('[aria-label], [title], [data-testid]'));
            for (const element of labelled) {
                const label = normalizedText([
                    element.getAttribute('aria-label'),
                    element.getAttribute('title'),
                    element.getAttribute('data-testid'),
                    element.textContent
                ].filter(Boolean).join(' '));
                if (!/skill|pickpocket|\bcs\b/i.test(label)) continue;
                const number = label.match(/(?:skill|level|\bcs\b)[^0-9]{0,12}(\d{1,3}(?:\.\d+)?)/i);
                const value = number && validSkill(number[1]);
                if (value !== null) {
                    writeStorage(STORAGE.LAST_AUTO_SKILL, value);
                    return value;
                }
            }

            const progressBars = Array.from(root.querySelectorAll('[role="progressbar"][aria-valuenow]'));
            for (const bar of progressBars) {
                const context = normalizedText([
                    bar.getAttribute('aria-label'), bar.getAttribute('title'),
                    bar.parentElement && bar.parentElement.textContent
                ].filter(Boolean).join(' '));
                if (!/skill|pickpocket|\bcs\b/i.test(context)) continue;
                const value = validSkill(bar.getAttribute('aria-valuenow'));
                if (value !== null) {
                    writeStorage(STORAGE.LAST_AUTO_SKILL, value);
                    return value;
                }
            }
        }

        return null;
    }

    function getSkillState() {
        const source = getSkillSource();
        if (source === 'MANUAL') {
            return { source, value: validSkill(readStorage(STORAGE.MANUAL_SKILL, '')) };
        }

        const detected = detectCrimeSkill();
        if (detected !== null) return { source, value: detected, detected: true };
        return {
            source,
            value: validSkill(readStorage(STORAGE.LAST_AUTO_SKILL, '')),
            detected: false
        };
    }

    function getTargetName(text) {
        const clean = normalizedText(text);
        return ALL_TARGETS.find(name => clean.includes(name)) || null;
    }

    function findPickButton(row) {
        if (!row) return null;
        const selectors = [
            'button.commit-button', '.commit-button', 'button[class*="commitButton"]',
            '[class*="commitButtonSection"] button', 'button[aria-label*="nerve" i]',
            'button[data-testid*="commit" i]', 'button[data-testid*="pick" i]'
        ];

        for (const selector of selectors) {
            const found = row.querySelector(selector);
            const button = found && (found.tagName === 'BUTTON' ? found : found.closest('button'));
            if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button)) {
                return button;
            }
        }

        const buttons = Array.from(row.querySelectorAll('button'));
        for (const button of buttons) {
            if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !visible(button)) continue;
            const label = normalizedText([
                button.textContent, button.getAttribute('aria-label'), button.className
            ].filter(Boolean).join(' ')).toLowerCase();
            if (/^5$/.test(label.replace(/\s/g, '')) || /nerve|commit|pick/.test(label)) return button;
        }
        return null;
    }

    function findRows() {
        const selectors = [
            'div.crime-option', '[class*="crimeOption"]', '[class*="crime-option"]',
            '[data-testid*="crime-option"]'
        ];
        let rows = Array.from(document.querySelectorAll(selectors.join(',')))
            .filter(row => getTargetName(row.textContent));

        if (!rows.length) {
            const roots = pickpocketRoots();
            for (const root of roots) {
                const candidates = Array.from(root.querySelectorAll('div, li, article'));
                rows.push(...candidates.filter(element => {
                    const text = normalizedText(element.textContent);
                    if (text.length > 550 || !getTargetName(text)) return false;
                    let targetCount = 0;
                    for (const name of ALL_TARGETS) if (text.includes(name)) targetCount++;
                    return targetCount === 1 && element.querySelector('button');
                }));
            }
        }

        rows = Array.from(new Set(rows));
        return rows.filter(row => !rows.some(other => other !== row && row.contains(other)));
    }

    function findNamedValue(row, names) {
        let text = normalizedText(row.textContent);
        const labelled = row.querySelectorAll('[aria-label], [title]');
        for (const element of labelled) {
            text += ' ' + normalizedText(element.getAttribute('aria-label'));
            text += ' ' + normalizedText(element.getAttribute('title'));
        }
        const lower = text.toLowerCase();
        return names.find(name => lower.includes(name.toLowerCase())) || '';
    }

    function targetDifficulty(name) {
        return DIFFICULTY_GROUPS.findIndex(group => group.includes(name));
    }

    function riskFor(name, build, activity, skill) {
        let risk = TARGET_RISK[name] === undefined ? 50 : TARGET_RISK[name];
        if (build && BUILD_RISK[build] !== undefined) risk += BUILD_RISK[build];
        if (activity && ACTIVITY_RISK[activity] !== undefined) risk += ACTIVITY_RISK[activity];
        risk -= (Math.max(1, Math.min(100, Number(skill) || 1)) - 1) * SKILL_RISK_RELIEF_PER_POINT;
        return Math.round(Math.max(0, Math.min(100, risk)) * 10) / 10;
    }

    function riskLabel(risk) {
        if (risk <= 20) return 'MINIMAL';
        if (risk <= 40) return 'LOW';
        if (risk <= 60) return 'MODERATE';
        if (risk <= 80) return 'HIGH';
        if (risk <= 100) return 'DANGEROUS';
        return 'EXTREME';
    }

    function riskColor(risk) {
        if (risk <= 20) return '#3db64b';
        if (risk <= 40) return '#78c66b';
        if (risk <= 60) return '#c9b63e';
        if (risk <= 80) return '#df9441';
        return '#df5555';
    }

    function scoreTarget(target, mode) {
        if (mode === 'MAX XP') return target.difficulty * 100000 - target.risk * 100;
        if (mode === 'BALANCED') {
            const dangerPenalty = target.risk >= 75 ? 100000 : (target.risk >= 60 ? 30000 : 0);
            return target.difficulty * 5000 - target.risk * 500 - dangerPenalty;
        }
        return -target.risk * 1000 - target.difficulty * 10;
    }

    function clearMarkedRows() {
        for (const row of markedRows) {
            if (!row || !row.style) continue;
            row.style.outline = '';
            row.style.outlineOffset = '';
            row.style.boxShadow = '';
            row.removeAttribute(ROW_MARK);
            const badges = row.querySelectorAll('.' + BADGE_CLASS);
            for (const badge of badges) badge.remove();
        }
        markedRows = new Set();
    }

    function paintRow(target, best) {
        const row = target.row;
        const oldBadges = row.querySelectorAll('.' + BADGE_CLASS);
        for (const badge of oldBadges) badge.remove();

        const color = riskColor(target.risk);
        row.style.outline = best ? '4px solid #37c84a' : '2px solid ' + color;
        row.style.outlineOffset = best ? '-4px' : '-2px';
        row.style.boxShadow = best ? 'inset 7px 0 0 #37c84a, 0 0 10px rgba(55,200,74,.85)' : '';
        row.setAttribute(ROW_MARK, '1');
        if (getComputedStyle(row).position === 'static') row.style.position = 'relative';

        const badge = document.createElement('div');
        badge.className = BADGE_CLASS;
        badge.textContent = best ? '★ BEST' : riskLabel(target.risk);
        badge.style.cssText = [
            'position:absolute', 'top:4px', 'right:5px', 'z-index:10', 'padding:3px 6px',
            'border-radius:6px', 'background:' + (best ? '#278f39' : color), 'color:#fff',
            'font-size:9px', 'font-weight:900', 'line-height:1.2',
            'box-shadow:0 1px 4px rgba(0,0,0,.45)', 'pointer-events:none'
        ].join(';');
        row.appendChild(badge);
        markedRows.add(row);
    }

    function outcomeRegex() {
        return /\b(SUCCESS|SUCCESSFUL|FAILURE|FAILED|CAUGHT|ARRESTED)\b/i;
    }

    function findOutcomeElement() {
        if (!document.body) return null;
        const likelyRoots = Array.from(document.querySelectorAll(
            '[role="dialog"], [class*="result" i], [class*="outcome" i], [class*="modal" i], [class*="success" i], [class*="failure" i]'
        ));
        likelyRoots.push(document.body);

        for (const root of Array.from(new Set(likelyRoots))) {
            if (!root || !visible(root)) continue;
            const elements = Array.from(root.querySelectorAll('div, section, article, li, h1, h2, h3, p, span'));
            const matches = elements.filter(element => {
                if (!visible(element)) return false;
                if (element.closest('#' + PANEL_ID + ', #' + MINI_ID + ', #' + PASSWORD_MENU_ID)) return false;
                const text = normalizedText(element.textContent);
                return text.length > 0 && text.length < 1200 && outcomeRegex().test(text);
            }).sort((a, b) => normalizedText(a.textContent).length - normalizedText(b.textContent).length);
            if (matches.length) return matches[0];
        }
        return null;
    }

    function closeLabel(element) {
        const svg = element.querySelector && element.querySelector('svg');
        return normalizedText([
            element.textContent,
            element.getAttribute && element.getAttribute('aria-label'),
            element.getAttribute && element.getAttribute('title'),
            element.getAttribute && element.getAttribute('data-testid'),
            element.className && String(element.className),
            svg && svg.getAttribute('aria-label'),
            svg && svg.getAttribute('data-icon'),
            svg && svg.className && String(svg.className.baseVal || svg.className)
        ].filter(Boolean).join(' ')).toLowerCase();
    }

    function namedCloseCandidate(container) {
        const selectors = [
            'button[aria-label*="close" i]', '[role="button"][aria-label*="close" i]',
            'button[title*="close" i]', '[role="button"][title*="close" i]',
            'button[data-testid*="close" i]', '[role="button"][data-testid*="close" i]',
            'button[class*="close" i]', '[role="button"][class*="close" i]',
            '[class*="close" i] button'
        ];
        for (const selector of selectors) {
            const candidate = container.matches && container.matches(selector) ? container : container.querySelector(selector);
            const clickable = candidate && (candidate.closest('button, [role="button"]') || candidate);
            if (clickable && visible(clickable) && !clickable.disabled) return clickable;
        }

        const candidates = Array.from(container.querySelectorAll('button, [role="button"]'));
        for (const candidate of candidates) {
            if (!visible(candidate) || candidate.disabled) continue;
            const label = closeLabel(candidate);
            if (label === 'x' || label === '×' || /\b(close|dismiss)\b/.test(label)) return candidate;
        }
        return null;
    }

    function geometricCloseCandidate(container) {
        if (!container || container === document.body) return null;
        const box = container.getBoundingClientRect();
        if (box.width < 80 || box.height < 40) return null;

        const candidates = Array.from(container.querySelectorAll('button, [role="button"]'))
            .filter(candidate => visible(candidate) && !candidate.disabled)
            .map(candidate => ({ candidate, box: candidate.getBoundingClientRect() }))
            .filter(item => item.box.width <= 72 && item.box.height <= 72)
            .filter(item => item.box.left >= box.left + box.width * 0.55)
            .filter(item => item.box.top <= box.top + Math.min(100, box.height * 0.35))
            .sort((a, b) => {
                const aDistance = Math.abs(box.right - a.box.right) + Math.abs(box.top - a.box.top);
                const bDistance = Math.abs(box.right - b.box.right) + Math.abs(box.top - b.box.top);
                return aDistance - bDistance;
            });
        return candidates.length ? candidates[0].candidate : null;
    }

    function findOutcomeCloseButton(outcome) {
        outcome = outcome || findOutcomeElement();
        if (!outcome) return null;

        const preferred = outcome.closest('[role="dialog"], [class*="modal" i], [class*="result" i], [class*="outcome" i]');
        if (preferred) {
            const named = namedCloseCandidate(preferred);
            if (named) return named;
            const geometric = geometricCloseCandidate(preferred);
            if (geometric) return geometric;
        }

        let container = outcome;
        for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
            const named = namedCloseCandidate(container);
            if (named) return named;
            if (depth >= 2) {
                const geometric = geometricCloseCandidate(container);
                if (geometric) return geometric;
            }
            if (container === document.body) break;
        }
        return null;
    }

    function setStatus(message) {
        const status = document.getElementById('aaron-pp-test-status');
        if (status) status.textContent = message;
    }

    function stopTimers() {
        if (autoPickTimer) clearTimeout(autoPickTimer);
        if (countdownTimer) clearInterval(countdownTimer);
        autoPickTimer = null;
        countdownTimer = null;
    }

    function stopAutoPick(message) {
        autoPickEnabled = false;
        stopTimers();
        const checkbox = document.getElementById('aaron-pp-test-auto');
        if (checkbox) checkbox.checked = false;
        updateAutoPickAppearance();
        if (message) setStatus(message);
    }

    function updateAutoPickAppearance() {
        const panel = document.getElementById(PANEL_ID);
        const label = document.getElementById('aaron-pp-test-auto-label');
        if (panel) panel.style.borderColor = autoPickEnabled ? '#ff4d4d' : 'rgba(255,255,255,.13)';
        if (label) label.style.background = autoPickEnabled ? '#8f2424' : '#3a2525';
    }

    function randomAutoDelay() {
        return Math.floor(Math.random() * (AUTO_PICK_MAX_DELAY_MS - AUTO_PICK_MIN_DELAY_MS + 1)) + AUTO_PICK_MIN_DELAY_MS;
    }

    function scheduleAutoPick() {
        if (!autoPickEnabled || !isAdminMode() || !isScanWanted() || isMinimized() || actionBusy) return;
        stopTimers();
        const delay = randomAutoDelay();
        const finishAt = Date.now() + delay;

        const updateCountdown = () => {
            if (!autoPickEnabled) return;
            const remaining = Math.max(0, finishAt - Date.now());
            setStatus('TEST AUTO • NEXT PICK: ' + (remaining / 1000).toFixed(1) + 's');
        };
        updateCountdown();
        countdownTimer = setInterval(updateCountdown, 100);
        autoPickTimer = setTimeout(() => {
            stopTimers();
            if (!autoPickEnabled || !isAdminMode() || !isScanWanted() || isMinimized()) return;
            scanTargets(true);
            performPick(true);
        }, delay);
    }

    function waitForOutcome(startedAt, automatic) {
        const outcome = findOutcomeElement();
        if (outcome) {
            const close = findOutcomeCloseButton(outcome);
            if (close) {
                setStatus('Result found • closing X');
                close.click();
                setTimeout(() => waitForOutcomeToClose(Date.now(), automatic), CLOSE_RETRY_MS);
                return;
            }
        }

        if (Date.now() - startedAt >= RESULT_WAIT_TIMEOUT_MS) {
            actionBusy = false;
            scanTargets(true);
            if (automatic) stopAutoPick('TEST AUTO stopped • result/X not found');
            else setStatus('Result/X not found • ready');
            return;
        }
        setTimeout(() => waitForOutcome(startedAt, automatic), RESULT_POLL_MS);
    }

    function waitForOutcomeToClose(startedAt, automatic) {
        const outcome = findOutcomeElement();
        if (!outcome) {
            actionBusy = false;
            scanTargets(true);
            if (automatic && autoPickEnabled) scheduleAutoPick();
            else setStatus('Ready • tap PICK BEST');
            return;
        }

        const close = findOutcomeCloseButton(outcome);
        if (close) close.click();

        if (Date.now() - startedAt >= CLOSE_TIMEOUT_MS) {
            actionBusy = false;
            scanTargets(true);
            if (automatic) stopAutoPick('TEST AUTO stopped • X would not close');
            else setStatus('X did not close • ready');
            return;
        }
        setTimeout(() => waitForOutcomeToClose(startedAt, automatic), CLOSE_RETRY_MS);
    }

    function performPick(automatic) {
        if (actionBusy || isMinimized()) return;
        if (automatic && !isAdminMode()) {
            stopAutoPick('Admin Mode required');
            return;
        }
        if (!isScanWanted()) {
            setStatus('Start SCAN first');
            if (automatic) stopAutoPick();
            return;
        }

        scanTargets(true);
        const button = currentBest && findPickButton(currentBest.row);
        if (!button) {
            setStatus('Pick button not found');
            if (automatic) stopAutoPick('TEST AUTO stopped • no pick button');
            return;
        }

        actionBusy = true;
        const pick = document.getElementById('aaron-pp-test-pick');
        if (pick) {
            pick.disabled = true;
            pick.style.opacity = '.45';
            pick.textContent = automatic ? 'TEST AUTO PICKING…' : 'PICKING…';
        }
        setStatus((automatic ? 'TEST AUTO' : 'Manual') + ' • pick sent');
        button.click();
        waitForOutcome(Date.now(), automatic);
    }

    function updateControls() {
        const scan = document.getElementById('aaron-pp-test-scan');
        const skillButton = document.getElementById('aaron-pp-test-skill');
        const checkbox = document.getElementById('aaron-pp-test-auto');
        const adminTab = document.getElementById('aaron-pp-test-tab-admin');
        const labTab = document.getElementById('aaron-pp-test-tab-lab');
        const tabBar = document.getElementById('aaron-pp-test-tab-bar');
        const version = document.getElementById('aaron-pp-test-version');
        if (scan) {
            const enabled = isScanWanted();
            scan.textContent = (enabled ? 'SCAN ON' : 'SCAN OFF') + ' • ' + getMode();
            scan.style.background = enabled ? '#267c3b' : '#555';
        }
        if (skillButton) {
            const state = getSkillState();
            if (state.value === null) skillButton.textContent = 'CS AUTO ?';
            else skillButton.textContent = 'CS ' + state.source + ' ' + state.value;
        }
        if (checkbox) checkbox.checked = autoPickEnabled;
        if (adminTab) adminTab.style.display = isAdminMode() ? 'block' : 'none';
        if (labTab) labTab.style.display = isAdminMode() ? 'block' : 'none';
        if (tabBar) tabBar.style.gridTemplateColumns = isAdminMode() ? 'repeat(4,1fr)' : 'repeat(2,1fr)';
        if (version) {
            version.textContent = isAdminMode() ? 'v1.0.0-test.1 • ADMIN ACTIVE' : 'v1.0.0-test.1 • HOLD FOR ADMIN';
            version.style.color = isAdminMode() ? '#ffbf84' : '#777';
        }

        const tabNames = ['main', 'admin', 'lab', 'settings'];
        for (const tabName of tabNames) {
            const button = document.getElementById('aaron-pp-test-tab-' + tabName);
            const view = document.getElementById('aaron-pp-test-view-' + tabName);
            if (button) button.style.background = activeTab === tabName ? '#67469b' : '#383838';
            if (view) view.style.display = activeTab === tabName ? 'block' : 'none';
        }

        const modeSetting = document.getElementById('aaron-pp-setting-mode');
        const skillSetting = document.getElementById('aaron-pp-setting-skill-source');
        const manualSetting = document.getElementById('aaron-pp-setting-manual-skill');
        const intervalSetting = document.getElementById('aaron-pp-setting-interval');
        const pauseSetting = document.getElementById('aaron-pp-setting-pause-mini');
        if (modeSetting) modeSetting.value = getMode();
        if (skillSetting) skillSetting.value = getSkillSource();
        if (manualSetting) {
            manualSetting.value = validSkill(readStorage(STORAGE.MANUAL_SKILL, '')) || '';
            manualSetting.disabled = getSkillSource() !== 'MANUAL';
            manualSetting.style.opacity = manualSetting.disabled ? '.45' : '1';
        }
        if (intervalSetting) intervalSetting.value = String(getScanInterval());
        if (pauseSetting) pauseSetting.checked = pauseWhenMinimized();
        updateAutoPickAppearance();
    }

    function scanTargets(force) {
        if (!isPickpocketPage()) {
            removeInterface();
            return;
        }

        ensureInterface();
        updateControls();
        if ((isMinimized() && pauseWhenMinimized()) || (!force && !isScanWanted()) || actionBusy) return;

        const staleOutcome = findOutcomeElement();
        if (staleOutcome) {
            const close = findOutcomeCloseButton(staleOutcome);
            if (close) {
                setStatus('Closing existing result X…');
                close.click();
            } else {
                setStatus('Result open • X not found');
            }
            return;
        }

        const skillState = getSkillState();
        if (skillState.value === null) {
            currentBest = null;
            clearMarkedRows();
            setStatus('CS not found • tap CS');
            updatePickButton();
            return;
        }

        const rows = findRows();
        const targets = [];
        for (const row of rows) {
            const name = getTargetName(row.textContent);
            if (!name) continue;
            const build = findNamedValue(row, BUILD_NAMES);
            const activity = findNamedValue(row, ACTIVITY_NAMES);
            const difficulty = targetDifficulty(name);
            const risk = riskFor(name, build, activity, skillState.value);
            const target = {
                row, name, build, activity, difficulty, risk
            };
            target.score = scoreTarget(target, getMode());
            targets.push(target);
        }

        clearMarkedRows();
        const available = targets.filter(target => findPickButton(target.row));
        available.sort((a, b) => b.score - a.score);
        currentBest = available[0] || null;
        for (const target of targets) paintRow(target, Boolean(currentBest && currentBest.row === target.row));

        if (!rows.length) setStatus('0 targets found');
        else if (!currentBest) setStatus('No available target');
        else setStatus(getMode() + ' • BEST: ' + currentBest.name + ' • Risk ' + currentBest.risk);
        updatePickButton();
    }

    function updatePickButton() {
        const pick = document.getElementById('aaron-pp-test-pick');
        if (!pick) return;
        const available = Boolean(currentBest && findPickButton(currentBest.row) && isScanWanted() && !actionBusy);
        pick.disabled = !available;
        pick.style.opacity = available ? '1' : '.45';
        pick.textContent = available ? 'PICK BEST • ' + currentBest.name : 'PICK BEST';
    }

    function buildDiagnostics() {
        const skill = getSkillState();
        const rows = findRows();
        const targets = rows.map(row => {
            const name = getTargetName(row.textContent);
            const build = findNamedValue(row, BUILD_NAMES);
            const activity = findNamedValue(row, ACTIVITY_NAMES);
            const difficulty = name ? targetDifficulty(name) : null;
            const risk = name && skill.value !== null ? riskFor(name, build, activity, skill.value) : null;
            return {
                name,
                build: build || null,
                activity: activity || null,
                difficulty: difficulty === null ? null : DIFFICULTY_NAMES[difficulty],
                risk,
                pickButtonFound: Boolean(findPickButton(row)),
                selectedBest: Boolean(currentBest && currentBest.row === row)
            };
        });
        const outcome = findOutcomeElement();
        return {
            report: 'Aaron Torn PDA Pickpocket Helper diagnostics',
            scriptVersion: '1.0.0-test.2',
            generatedAt: new Date().toISOString(),
            page: {
                origin: location.origin,
                pathname: location.pathname,
                title: document.title,
                viewport: window.innerWidth + 'x' + window.innerHeight,
                pickpocketPageDetected: isPickpocketPage()
            },
            settings: {
                mode: getMode(),
                scanEnabled: isScanWanted(),
                scanIntervalMs: getScanInterval(),
                minimized: isMinimized(),
                pauseWhenMinimized: pauseWhenMinimized()
            },
            admin: {
                enabled: isAdminMode(),
                activeTab,
                autoPickEnabled,
                actionBusy
            },
            crimeSkill: {
                source: skill.source,
                value: skill.value,
                freshlyDetected: Boolean(skill.detected)
            },
            resultPopup: {
                detected: Boolean(outcome),
                closeButtonFound: Boolean(outcome && findOutcomeCloseButton(outcome))
            },
            targetCount: targets.length,
            currentBest: currentBest ? {
                name: currentBest.name,
                build: currentBest.build || null,
                activity: currentBest.activity || null,
                difficulty: DIFFICULTY_NAMES[currentBest.difficulty],
                risk: currentBest.risk
            } : null,
            targets,
            timingMs: {
                resultPoll: RESULT_POLL_MS,
                resultWaitTimeout: RESULT_WAIT_TIMEOUT_MS,
                closeRetry: CLOSE_RETRY_MS,
                closeTimeout: CLOSE_TIMEOUT_MS,
                autoPickMinimum: AUTO_PICK_MIN_DELAY_MS,
                autoPickMaximum: AUTO_PICK_MAX_DELAY_MS
            }
        };
    }

    async function copyDiagnostics() {
        if (!isAdminMode()) {
            setStatus('Admin Mode required');
            return;
        }
        const text = JSON.stringify(buildDiagnostics(), null, 2);
        try {
            await navigator.clipboard.writeText(text);
            setStatus('Diagnostic data copied');
            return;
        } catch (error) {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(area);
            area.focus();
            area.select();
            const copied = document.execCommand('copy');
            area.remove();
            setStatus(copied ? 'Diagnostic data copied' : 'Could not copy diagnostics');
        }
    }

    async function setActiveTab(tabName) {
        if ((tabName === 'admin' || tabName === 'lab') && !isAdminMode()) {
            const unlocked = await unlockAdminMode();
            if (!unlocked) return;
        }
        activeTab = tabName;
        updateControls();
    }

    function bindAdminActivation(button) {
        let timer = null;
        let activated = false;
        const start = event => {
            if (event.type === 'mousedown' && event.button !== 0) return;
            activated = false;
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                activated = true;
                if (navigator.vibrate) navigator.vibrate(25);
                const unlocked = await unlockAdminMode();
                if (unlocked) setActiveTab('admin');
            }, 1000);
        };
        const end = () => {
            if (timer) clearTimeout(timer);
            timer = null;
        };
        button.addEventListener('touchstart', start, { passive: true });
        button.addEventListener('touchend', end);
        button.addEventListener('touchcancel', end);
        button.addEventListener('mousedown', start);
        button.addEventListener('mouseup', end);
        button.addEventListener('mouseleave', end);
        button.addEventListener('click', event => {
            if (activated) {
                event.preventDefault();
                activated = false;
            } else {
                setStatus(isAdminMode() ? 'Admin Mode is active' : 'Hold version for Admin Mode');
            }
        });
    }

    function askPassword(title, buttonText) {
        return new Promise(resolve => {
            const existing = document.getElementById(PASSWORD_MENU_ID);
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = PASSWORD_MENU_ID;
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:2147483647', 'background:rgba(0,0,0,.72)',
                'display:flex', 'align-items:center', 'justify-content:center', 'padding:16px'
            ].join(';');
            const card = document.createElement('form');
            card.style.cssText = 'width:min(420px,100%);background:#202020;border:1px solid #666;border-radius:15px;padding:14px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
            card.innerHTML = `
                <div style="font-size:14px;font-weight:900;margin-bottom:10px;">${title}</div>
                <input type="password" autocomplete="off" inputmode="text" aria-label="Admin password" style="box-sizing:border-box;width:100%;min-height:46px;border:1px solid #777;border-radius:9px;background:#111;color:#fff;padding:9px;font-size:16px;">
                <div style="display:flex;gap:8px;margin-top:11px;">
                    <button type="button" data-action="cancel" style="flex:1;min-height:43px;border:0;border-radius:9px;background:#555;color:#fff;font-weight:900;">CANCEL</button>
                    <button type="submit" style="flex:1;min-height:43px;border:0;border-radius:9px;background:#67469b;color:#fff;font-weight:900;">${buttonText}</button>
                </div>
            `;
            const input = card.querySelector('input');
            const finish = value => {
                overlay.remove();
                resolve(value);
            };
            card.addEventListener('submit', event => {
                event.preventDefault();
                finish(input.value);
            });
            card.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
            overlay.addEventListener('click', event => {
                if (event.target === overlay) finish(null);
            });
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            setTimeout(() => input.focus(), 50);
        });
    }

    async function unlockAdminMode() {
        if (isAdminMode()) {
            setStatus('Admin Mode is already enabled');
            return true;
        }
        if (!crypto || !crypto.subtle || !crypto.getRandomValues) {
            setStatus('Secure password storage is unavailable');
            return false;
        }

        const remainingLock = adminLockedUntil - Date.now();
        if (remainingLock > 0) {
            setStatus('Admin login locked • wait ' + Math.ceil(remainingLock / 1000) + 's');
            return false;
        }

        let savedHash = readStorage(STORAGE.ADMIN_HASH, '');
        let salt = readStorage(STORAGE.ADMIN_SALT, '');
        if (!savedHash || !salt) {
            const first = await askPassword('CREATE ADMIN PASSWORD', 'CONTINUE');
            if (first === null) return false;
            if (first.length < 4) {
                setStatus('Admin password must be at least 4 characters');
                return false;
            }
            const second = await askPassword('CONFIRM ADMIN PASSWORD', 'CREATE');
            if (second === null) return false;
            if (first !== second) {
                setStatus('Passwords did not match');
                return false;
            }
            salt = randomSalt();
            savedHash = await hashPassword(first, salt);
            writeStorage(STORAGE.ADMIN_SALT, salt);
            writeStorage(STORAGE.ADMIN_HASH, savedHash);
        } else {
            const entered = await askPassword('ENTER ADMIN PASSWORD', 'UNLOCK');
            if (entered === null) return false;
            const enteredHash = await hashPassword(entered, salt);
            if (enteredHash !== savedHash) {
                failedAdminAttempts++;
                if (failedAdminAttempts >= 3) {
                    failedAdminAttempts = 0;
                    adminLockedUntil = Date.now() + 30000;
                    setStatus('Incorrect password • locked for 30s');
                } else {
                    setStatus('Incorrect password • ' + (3 - failedAdminAttempts) + ' attempts left');
                }
                return false;
            }
        }

        failedAdminAttempts = 0;
        adminLockedUntil = 0;
        writeStorage(STORAGE.ADMIN_ENABLED, true);
        updateControls();
        setStatus('Admin Mode enabled');
        return true;
    }

    function makePanel() {
        if (!document.body || document.getElementById(PANEL_ID)) return;
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = [
            'position:fixed', 'left:8px', 'right:8px', 'bottom:calc(10px + env(safe-area-inset-bottom))',
            'z-index:2147483646', 'padding:8px', 'border-radius:13px', 'background:rgba(20,20,20,.97)',
            'border:2px solid rgba(255,255,255,.13)', 'color:#fff', 'box-shadow:0 4px 14px rgba(0,0,0,.5)',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        ].join(';');
        panel.innerHTML = `
            <div id="aaron-pp-test-tab-bar" style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;margin-bottom:7px;">
                <button id="aaron-pp-test-tab-main" type="button" style="border:0;border-radius:8px;min-height:34px;background:#67469b;color:#fff;font-size:9px;font-weight:900;">MAIN</button>
                <button id="aaron-pp-test-tab-admin" type="button" style="display:none;border:0;border-radius:8px;min-height:34px;background:#383838;color:#fff;font-size:9px;font-weight:900;">ADMIN</button>
                <button id="aaron-pp-test-tab-lab" type="button" style="display:none;border:0;border-radius:8px;min-height:34px;background:#383838;color:#fff;font-size:9px;font-weight:900;">LAB</button>
                <button id="aaron-pp-test-tab-settings" type="button" style="border:0;border-radius:8px;min-height:34px;background:#383838;color:#fff;font-size:9px;font-weight:900;">SETTINGS</button>
            </div>
            <div id="aaron-pp-test-status" style="margin-bottom:7px;padding:6px 8px;border-radius:7px;background:#292929;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10px;font-weight:800;">Looking…</div>
            <div id="aaron-pp-test-view-main">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                    <button id="aaron-pp-test-skill" type="button" style="flex:1;border:0;border-radius:9px;min-height:38px;padding:7px 9px;background:#444;color:#fff;font-size:10px;font-weight:900;">CS AUTO ?</button>
                    <button id="aaron-pp-test-scan" type="button" style="flex:2;border:0;border-radius:9px;min-height:38px;padding:7px 9px;background:#267c3b;color:#fff;font-size:9px;font-weight:900;">SCAN ON</button>
                    <button id="aaron-pp-test-minimize" type="button" aria-label="Minimize helper" style="border:0;border-radius:9px;width:38px;min-height:38px;background:#555;color:#fff;font-size:18px;font-weight:900;">−</button>
                </div>
                <button id="aaron-pp-test-pick" type="button" disabled style="width:100%;border:0;border-radius:10px;min-height:48px;padding:10px;background:#248c3e;color:#fff;font-size:15px;font-weight:900;opacity:.45;">PICK BEST</button>
            </div>
            <div id="aaron-pp-test-view-admin" style="display:none;">
                <div style="padding:8px;margin-bottom:7px;border-radius:9px;background:#54311f;color:#ffd1ad;font-size:10px;font-weight:900;">ADMIN MODE • TEST CONTROLS</div>
                <label id="aaron-pp-test-auto-label" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;padding:9px;border-radius:9px;background:#3a2525;color:#ffb1b1;font-size:10px;font-weight:900;">
                    <input id="aaron-pp-test-auto" type="checkbox" style="width:20px;height:20px;accent-color:#e34848;">
                    AUTO PICK — TEST ONLY
                </label>
                <button id="aaron-pp-test-copy-diagnostics" type="button" style="width:100%;min-height:43px;margin-bottom:7px;border:0;border-radius:9px;background:#315b78;color:#fff;font-size:11px;font-weight:900;">COPY DIAGNOSTIC DATA</button>
                <button id="aaron-pp-test-disable-admin" type="button" style="width:100%;min-height:43px;border:0;border-radius:9px;background:#8f2f2f;color:#fff;font-size:11px;font-weight:900;">DISABLE ADMIN MODE</button>
            </div>
            <div id="aaron-pp-test-view-lab" style="display:none;">
                <div style="padding:15px;border:1px dashed #777;border-radius:10px;text-align:center;color:#bbb;font-size:11px;font-weight:800;">No experimental features installed</div>
            </div>
            <div id="aaron-pp-test-view-settings" style="display:none;">
                <label style="display:block;margin-bottom:7px;font-size:10px;font-weight:900;">TARGET MODE
                    <select id="aaron-pp-setting-mode" style="box-sizing:border-box;width:100%;min-height:40px;margin-top:4px;border:1px solid #666;border-radius:8px;background:#292929;color:#fff;padding:7px;font-weight:800;">
                        <option>MAX XP</option><option>BALANCED</option><option>SAFEST</option>
                    </select>
                </label>
                <label style="display:block;margin-bottom:7px;font-size:10px;font-weight:900;">CRIME SKILL SOURCE
                    <select id="aaron-pp-setting-skill-source" style="box-sizing:border-box;width:100%;min-height:40px;margin-top:4px;border:1px solid #666;border-radius:8px;background:#292929;color:#fff;padding:7px;font-weight:800;">
                        <option value="AUTO">AUTO DETECT</option><option value="MANUAL">MANUAL</option>
                    </select>
                </label>
                <label style="display:block;margin-bottom:7px;font-size:10px;font-weight:900;">MANUAL CRIME SKILL
                    <input id="aaron-pp-setting-manual-skill" type="number" min="1" max="100" step="0.01" placeholder="1–100" style="box-sizing:border-box;width:100%;min-height:40px;margin-top:4px;border:1px solid #666;border-radius:8px;background:#292929;color:#fff;padding:7px;font-weight:800;">
                </label>
                <label style="display:block;margin-bottom:7px;font-size:10px;font-weight:900;">SCAN INTERVAL
                    <select id="aaron-pp-setting-interval" style="box-sizing:border-box;width:100%;min-height:40px;margin-top:4px;border:1px solid #666;border-radius:8px;background:#292929;color:#fff;padding:7px;font-weight:800;">
                        <option value="250">250 milliseconds</option><option value="500">500 milliseconds</option><option value="1000">1,000 milliseconds</option><option value="1200">1,200 milliseconds</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px;border-radius:8px;background:#292929;font-size:10px;font-weight:900;">
                    <input id="aaron-pp-setting-pause-mini" type="checkbox" style="width:19px;height:19px;accent-color:#67469b;"> PAUSE SCANNING WHILE MINIMIZED
                </label>
                <button id="aaron-pp-setting-reset" type="button" style="width:100%;min-height:40px;border:0;border-radius:9px;background:#555;color:#fff;font-size:10px;font-weight:900;">RESET HELPER SETTINGS</button>
            </div>
            <button id="aaron-pp-test-version" type="button" style="display:block;width:100%;margin-top:6px;border:0;background:transparent;text-align:center;color:#777;font-size:8px;font-weight:800;touch-action:manipulation;">v1.0.0-test.1 • HOLD FOR ADMIN</button>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#aaron-pp-test-tab-main').addEventListener('click', () => setActiveTab('main'));
        panel.querySelector('#aaron-pp-test-tab-admin').addEventListener('click', () => setActiveTab('admin'));
        panel.querySelector('#aaron-pp-test-tab-lab').addEventListener('click', () => setActiveTab('lab'));
        panel.querySelector('#aaron-pp-test-tab-settings').addEventListener('click', () => setActiveTab('settings'));
        bindAdminActivation(panel.querySelector('#aaron-pp-test-version'));
        panel.querySelector('#aaron-pp-test-skill').addEventListener('click', () => setActiveTab('settings'));
        panel.querySelector('#aaron-pp-test-scan').addEventListener('click', () => setScanWanted(!isScanWanted()));
        panel.querySelector('#aaron-pp-test-minimize').addEventListener('click', () => setMinimized(true));
        panel.querySelector('#aaron-pp-test-pick').addEventListener('click', () => performPick(false));
        panel.querySelector('#aaron-pp-test-auto').addEventListener('change', event => {
            if (event.target.checked) {
                if (!isAdminMode()) {
                    event.target.checked = false;
                    setStatus('Admin Mode required');
                    return;
                }
                if (!isScanWanted()) {
                    event.target.checked = false;
                    setStatus('Start SCAN before Auto Pick');
                    return;
                }
                autoPickEnabled = true;
                updateAutoPickAppearance();
                scheduleAutoPick();
            } else {
                stopAutoPick('Auto Pick off');
            }
        });
        panel.querySelector('#aaron-pp-test-copy-diagnostics').addEventListener('click', copyDiagnostics);
        panel.querySelector('#aaron-pp-test-disable-admin').addEventListener('click', disableAdminMode);
        panel.querySelector('#aaron-pp-setting-mode').addEventListener('change', event => setMode(event.target.value));
        panel.querySelector('#aaron-pp-setting-skill-source').addEventListener('change', event => {
            writeStorage(STORAGE.SKILL_SOURCE, event.target.value === 'MANUAL' ? 'MANUAL' : 'AUTO');
            updateControls();
            scanTargets(true);
        });
        panel.querySelector('#aaron-pp-setting-manual-skill').addEventListener('change', event => {
            const value = validSkill(event.target.value);
            if (value === null) {
                setStatus('Manual Crime Skill must be 1–100');
                updateControls();
                return;
            }
            writeStorage(STORAGE.MANUAL_SKILL, value);
            writeStorage(STORAGE.SKILL_SOURCE, 'MANUAL');
            updateControls();
            scanTargets(true);
        });
        panel.querySelector('#aaron-pp-setting-interval').addEventListener('change', event => {
            writeStorage(STORAGE.SCAN_INTERVAL, event.target.value);
            restartScanLoop();
            updateControls();
            setStatus('Scan interval: ' + getScanInterval() + ' ms');
        });
        panel.querySelector('#aaron-pp-setting-pause-mini').addEventListener('change', event => {
            writeStorage(STORAGE.PAUSE_MINIMIZED, event.target.checked);
            updateControls();
        });
        panel.querySelector('#aaron-pp-setting-reset').addEventListener('click', () => {
            stopAutoPick();
            [STORAGE.MODE, STORAGE.SCAN, STORAGE.MINIMIZED, STORAGE.SKILL_SOURCE,
                STORAGE.MANUAL_SKILL, STORAGE.LAST_AUTO_SKILL, STORAGE.SCAN_INTERVAL,
                STORAGE.PAUSE_MINIMIZED].forEach(removeStorage);
            restartScanLoop();
            updateControls();
            scanTargets(true);
            setStatus('Helper settings reset');
        });
        updateControls();
    }

    function makeMiniButton() {
        if (!document.body || document.getElementById(MINI_ID)) return;
        const mini = document.createElement('button');
        mini.id = MINI_ID;
        mini.type = 'button';
        mini.textContent = 'PP';
        mini.setAttribute('aria-label', 'Restore Pickpocket Helper');
        mini.style.cssText = [
            'position:fixed', 'left:9px', 'bottom:calc(10px + env(safe-area-inset-bottom))',
            'z-index:2147483646', 'width:48px', 'height:48px', 'border:2px solid #6ac675',
            'border-radius:50%', 'background:#202020', 'color:#fff', 'font-size:13px', 'font-weight:900',
            'box-shadow:0 3px 12px rgba(0,0,0,.55)'
        ].join(';');
        mini.addEventListener('click', () => setMinimized(false));
        document.body.appendChild(mini);
    }

    function renderPanelState() {
        const panel = document.getElementById(PANEL_ID);
        const mini = document.getElementById(MINI_ID);
        if (isMinimized()) {
            if (panel) panel.remove();
            makeMiniButton();
        } else {
            if (mini) mini.remove();
            makePanel();
            updateControls();
        }
    }

    function ensureInterface() {
        renderPanelState();
    }

    function removeInterface() {
        stopAutoPick();
        clearMarkedRows();
        currentBest = null;
        const panel = document.getElementById(PANEL_ID);
        const mini = document.getElementById(MINI_ID);
        if (panel) panel.remove();
        if (mini) mini.remove();
    }

    function queueScan() {
        if (scanQueued) return;
        scanQueued = true;
        setTimeout(() => {
            scanQueued = false;
            scanTargets(false);
        }, 120);
    }

    const observer = new MutationObserver(queueScan);
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });

    // Auto Pick is intentionally never restored from storage.
    autoPickEnabled = false;
    restartScanLoop();
    setTimeout(() => scanTargets(true), 250);
})();
