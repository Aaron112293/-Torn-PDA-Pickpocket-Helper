// ==UserScript==
// @name         Torn PDA Pickpocket Helper v0.5.3
// @namespace    torn-pda-local
// @version      0.5.3
// @description  Reliable Torn PDA startup with one-tap picking and automatic result closing
// @match        https://www.torn.com/loader.php?sid=crimes*
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @downloadURL  https://raw.githubusercontent.com/Aaron112293/-Torn-PDA-Pickpocket-Helper/main/Torn_PDA_Pickpocket_Helper_v0.5.2.user.js
// @updateURL    https://raw.githubusercontent.com/Aaron112293/-Torn-PDA-Pickpocket-Helper/main/Torn_PDA_Pickpocket_Helper_v0.5.2.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const PANEL_ID = 'aaron-pp-helper';
    const SKILL_KEY = 'aaron_pp_skill';
    const MODE_KEY = 'aaron_pp_mode';
    const SCAN_KEY = 'aaron_pp_scan_enabled';
    const SCAN_INTERVAL_MS = 1200;
    const RESULT_WAIT_TIMEOUT_MS = 15000;
    const RESULT_CLOSE_TIMEOUT_MS = 3500;

    const MODES = ['MAX XP', 'BALANCED', 'VERY SAFE'];

    const GROUPS = [
        ['Drunk man', 'Drunk woman', 'Homeless person', 'Junkie', 'Elderly man', 'Elderly woman'],
        ['Laborer', 'Postal worker', 'Young man', 'Young woman', 'Student'],
        ['Classy lady', 'Rich kid', 'Sex worker'],
        ['Thug', 'Jogger', 'Businessman', 'Businesswoman', 'Gang member'],
        ['Cyclist'],
        ['Mobster', 'Police officer']
    ];

    const SKILL_STARTS = [1, 10, 35, 65, 90, 100];
    const ALL_TARGETS = GROUPS.flat();

    const TARGET_RISK = {
        'Drunk man': 5, 'Drunk woman': 5, 'Homeless person': 5, 'Junkie': 8,
        'Elderly woman': 10, 'Elderly man': 15,
        'Young woman': 30, 'Student': 35, 'Postal worker': 35,
        'Young man': 40, 'Classy lady': 40,
        'Businessman': 45, 'Businesswoman': 45, 'Sex worker': 45,
        'Rich kid': 50, 'Jogger': 55,
        'Laborer': 60, 'Cyclist': 65,
        'Thug': 80, 'Gang member': 85, 'Mobster': 90,
        'Police officer': 100
    };

    const BUILD_RISK = {
        'Skinny': -5,
        'Average': 5,
        'Heavyset': 8,
        'Athletic': 15,
        'Muscular': 20
    };

    const ACTIVITY_RISK = {
        'Stumbling': -15,
        'Distracted': -12,
        'Begging': -10,
        'Loitering': -8,
        'Listening to music': -5,
        'Soliciting': 0,
        'On Phone': 5,
        'On phone': 5,
        'Walking': 10,
        'Jogging': 15,
        'Cycling': 20,
        'Running': 25,
        'Alert': 30,
        'Chasing': 35
    };

    const BUILD_NAMES = Object.keys(BUILD_RISK);
    const ACTIVITY_NAMES = Object.keys(ACTIVITY_RISK);

    let previousBest = null;
    let currentBest = null;
    let actionBusy = false;
    let scanTimer = null;

    function onPickpocketPage() {
        const href = String(location.href || '').toLowerCase();

        if (href.includes('pickpocketing')) return true;

        if (document.querySelector('.pickpocketing-root, [class*="pickpocketing"], [data-testid*="pickpocket"]')) {
            return true;
        }

        // Torn PDA can keep the address at loader.php?sid=crimes while its
        // internal SPA changes pages. Do not depend on a hash being present.
        const pageText = String((document.body && document.body.innerText) || '');
        const hasTarget = ALL_TARGETS.some(name => pageText.includes(name));
        const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
        const hasHeading = headings.some(element =>
            String(element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === 'pickpocketing'
        );
        const isCrimesRoute = href.includes('loader.php') && href.includes('sid=crimes');

        return (hasHeading && (isCrimesRoute || hasTarget)) || (isCrimesRoute && hasTarget);
    }

    function isVisible(element) {
        if (!element || !document.body.contains(element)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function getSkill() {
        const saved = Number(localStorage.getItem(SKILL_KEY));
        return saved >= 1 && saved <= 100 ? saved : 1;
    }

    function getMode() {
        const saved = localStorage.getItem(MODE_KEY);
        return MODES.includes(saved) ? saved : 'BALANCED';
    }

    function nextMode() {
        const index = MODES.indexOf(getMode());
        const next = MODES[(index + 1) % MODES.length];
        localStorage.setItem(MODE_KEY, next);
        return next;
    }

    function getScanEnabled() {
        return localStorage.getItem(SCAN_KEY) !== 'false';
    }

    function setScanEnabled(enabled) {
        localStorage.setItem(SCAN_KEY, String(Boolean(enabled)));
        updateScanTimer();
    }

    function getPlayerTier(skill) {
        let tier = 0;
        for (let i = 0; i < SKILL_STARTS.length; i++) {
            if (Math.floor(skill) >= SKILL_STARTS[i]) tier = i;
        }
        return tier;
    }

    function getTargetTier(name) {
        return GROUPS.findIndex(group => group.includes(name));
    }

    function getTargetName(text) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        return ALL_TARGETS.find(name => clean.includes(name)) || null;
    }

    function findRows() {
        let rows = [...document.querySelectorAll('div.crime-option')];
        if (rows.length) return rows;

        rows = [...document.querySelectorAll('.pickpocketing-root div')].filter(el => {
            const text = String(el.textContent || '');
            if (!getTargetName(text)) return false;
            let count = 0;
            for (const name of ALL_TARGETS) {
                if (text.includes(name)) count++;
            }
            return count === 1 && text.length < 350;
        });

        return rows.filter(row => !rows.some(other => other !== row && row.contains(other)));
    }

    function findBuild(row) {
        const text = String(row.textContent || '').toLowerCase();
        return BUILD_NAMES.find(build => text.includes(build.toLowerCase())) || '';
    }

    function findActivity(row) {
        let combined = String(row.textContent || '');
        for (const element of row.querySelectorAll('[aria-label], [title]')) {
            combined += ' ' + (element.getAttribute('aria-label') || '');
            combined += ' ' + (element.getAttribute('title') || '');
        }
        const lower = combined.toLowerCase();
        return ACTIVITY_NAMES.find(activity => lower.includes(activity.toLowerCase())) || '';
    }

    function calculateRisk(name, build, activity) {
        let score = TARGET_RISK[name] ?? 50;
        if (build && BUILD_RISK[build] !== undefined) score += BUILD_RISK[build];
        if (activity && ACTIVITY_RISK[activity] !== undefined) score += ACTIVITY_RISK[activity];
        return Math.max(0, score);
    }

    function riskLabel(score) {
        if (score <= 20) return 'MINIMAL';
        if (score <= 40) return 'LOW';
        if (score <= 60) return 'MODERATE';
        if (score <= 80) return 'HIGH';
        if (score <= 100) return 'DANGEROUS';
        return 'EXTREME';
    }

    function getSkillRating(name, skill) {
        const playerTier = getPlayerTier(skill);
        const targetTier = getTargetTier(name);
        if (targetTier > playerTier) return 'LOCKED';
        if (targetTier === playerTier) return 'IDEAL';
        if (targetTier === playerTier - 1) return 'GOOD';
        return 'EASY';
    }

    function calculateScore(target, skill, mode) {
        const playerTier = getPlayerTier(skill);
        if (target.tier > playerTier) return -1000000;
        if (mode === 'MAX XP') return target.tier * 100000 - target.risk;
        if (mode === 'BALANCED') {
            if (target.risk >= 85) return target.tier * 1000 - target.risk * 100;
            return target.tier * 5000 - target.risk * 50;
        }
        if (mode === 'VERY SAFE') return -target.risk * 1000 + target.tier * 10;
        return 0;
    }

    function findNativePickButton(row) {
        if (!row) return null;

        const selectors = [
            'button.commit-button',
            '.commit-button',
            'button[class*="commitButton"]',
            '[class*="commitButtonSection"] button',
            '[class*="commitButtonSection___"] button',
            'button[aria-label*="nerve" i]'
        ];

        for (const selector of selectors) {
            const element = row.querySelector(selector);
            if (!element) continue;
            const button = element.tagName === 'BUTTON' ? element : element.closest('button');
            if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
            return button;
        }

        for (const button of row.querySelectorAll('button')) {
            if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
            const text = String(button.textContent || '').replace(/\s+/g, '').trim();
            const aria = String(button.getAttribute('aria-label') || '').toLowerCase();
            const classes = String(button.className || '').toLowerCase();
            if (text === '5' || aria.includes('nerve') || classes.includes('commit')) return button;
        }

        return null;
    }

    // Finds the X belonging to a visible SUCCESS/FAIL result, not Torn PDA's browser X.
    function findOutcomeCloseButton() {
        const roots = [...document.querySelectorAll('.pickpocketing-root, [class*="pickpocket"]')];
        const searchRoots = roots.length ? roots : [document.body];

        for (const root of searchRoots) {
            const elements = [...root.querySelectorAll('div, section, article, li')];
            const outcome = elements
                .filter(isVisible)
                .filter(el => /(^|\s)(SUCCESS|FAILURE|FAILED)(\s|$)/i.test(String(el.textContent || '')))
                .sort((a, b) => a.textContent.length - b.textContent.length)[0];

            if (!outcome) continue;

            let container = outcome;
            for (let depth = 0; depth < 5 && container; depth++, container = container.parentElement) {
                const selectors = [
                    'button[aria-label*="close" i]',
                    '[role="button"][aria-label*="close" i]',
                    'button[title*="close" i]',
                    '[class*="close"] button',
                    'button[class*="close"]',
                    '[class*="close"]'
                ];

                for (const selector of selectors) {
                    const candidate = container.querySelector(selector);
                    if (candidate && isVisible(candidate)) return candidate;
                }

                const candidates = [...container.querySelectorAll('button, [role="button"], svg')];
                for (const candidate of candidates) {
                    const clickable = candidate.closest('button, [role="button"]') || candidate;
                    if (!isVisible(clickable)) continue;
                    const label = [
                        clickable.textContent,
                        clickable.getAttribute && clickable.getAttribute('aria-label'),
                        clickable.getAttribute && clickable.getAttribute('title'),
                        clickable.className && String(clickable.className)
                    ].filter(Boolean).join(' ').trim().toLowerCase();
                    if (label === 'x' || label === '×' || label.includes('close')) return clickable;
                }
            }
        }

        return null;
    }

    function clearRow(row) {
        row.style.outline = '';
        row.style.outlineOffset = '';
        row.style.boxShadow = '';
        row.removeAttribute('data-aaron-pp');
        const badge = row.querySelector('.aaron-pp-badge');
        if (badge) badge.remove();
    }

    function getRiskColor(rating, risk) {
        if (rating === 'LOCKED') return '#e65c5c';
        if (risk <= 20) return '#43bd39';
        if (risk <= 40) return '#76c96b';
        if (risk <= 60) return '#d4bd48';
        if (risk <= 80) return '#e59a45';
        return '#e65c5c';
    }

    function addBadge(row, text, color) {
        const badge = document.createElement('div');
        badge.className = 'aaron-pp-badge';
        badge.textContent = text;
        badge.style.cssText = `
            position:absolute; top:4px; right:5px; z-index:10; padding:3px 6px;
            border-radius:6px; background:${color}; color:white; font-size:9px;
            font-weight:900; line-height:1.2; box-shadow:0 1px 4px rgba(0,0,0,.45);
            pointer-events:none;
        `;
        if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
        row.appendChild(badge);
    }

    function paintRow(target, best) {
        const row = target.row;
        clearRow(row);
        const color = getRiskColor(target.skillRating, target.risk);
        row.style.outline = `2px solid ${color}`;
        row.style.outlineOffset = '-2px';

        if (best) {
            row.style.outline = '4px solid #37c84a';
            row.style.outlineOffset = '-4px';
            row.style.boxShadow = 'inset 7px 0 0 #37c84a,0 0 10px rgba(55,200,74,.85)';
            addBadge(row, '★ BEST', '#278f39');
            return;
        }
        addBadge(row, riskLabel(target.risk), color);
    }

    function setStatus(message) {
        const status = document.querySelector('#aaron-pp-status');
        if (status) status.textContent = message;
    }

    function updateScanControl() {
        const button = document.querySelector('#aaron-pp-toggle-scan');
        if (!button) return;
        const enabled = getScanEnabled();
        button.textContent = enabled ? 'STOP SCAN' : 'START SCAN';
        button.style.background = enabled ? '#b33b3b' : '#248c3e';
    }

    function updateScanTimer() {
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
        // Keep page discovery alive even when target scanning is stopped.
        // Previously, saving STOP SCAN could prevent the panel from ever
        // appearing again when Torn PDA loaded the crime page slowly.
        scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
        updateScanControl();
    }

    function makePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;
        if (!document.body) return null;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            position:fixed; left:8px; right:8px;
            bottom:calc(10px + env(safe-area-inset-bottom)); z-index:2147483646;
            padding:8px; border-radius:13px; background:rgba(20,20,20,.97);
            border:1px solid rgba(255,255,255,.10); color:white;
            box-shadow:0 4px 14px rgba(0,0,0,.50);
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        `;

        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                <button id="aaron-pp-skill" type="button" style="border:0;border-radius:9px;min-height:38px;padding:7px 9px;background:#444;color:white;font-size:11px;font-weight:900;">CS ?</button>
                <button id="aaron-pp-mode" type="button" style="border:0;border-radius:9px;min-height:38px;padding:7px 9px;background:#67469b;color:white;font-size:10px;font-weight:900;">MODE</button>
                <div id="aaron-pp-status" style="flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10px;font-weight:800;">Looking…</div>
                <button id="aaron-pp-toggle-scan" type="button" style="border:0;border-radius:9px;min-height:38px;padding:7px 9px;color:white;font-size:9px;font-weight:900;">STOP SCAN</button>
            </div>
            <button id="aaron-pp-pick" type="button" disabled style="width:100%;border:0;border-radius:10px;min-height:48px;padding:10px;background:#248c3e;color:white;font-size:15px;font-weight:900;opacity:.45;">PICK BEST</button>
        `;

        document.body.appendChild(panel);

        panel.querySelector('#aaron-pp-skill').addEventListener('click', () => {
            const answer = prompt('Enter Pickpocket Crime Skill:', getSkill());
            if (answer === null) return;
            const value = Number(answer);
            if (!Number.isFinite(value) || value < 1 || value > 100) {
                alert('Enter a number from 1 to 100.');
                return;
            }
            localStorage.setItem(SKILL_KEY, String(value));
            scan(true);
        });

        panel.querySelector('#aaron-pp-mode').addEventListener('click', () => {
            nextMode();
            scan(true);
        });

        panel.querySelector('#aaron-pp-toggle-scan').addEventListener('click', () => {
            const enabled = !getScanEnabled();
            setScanEnabled(enabled);
            if (enabled) {
                setStatus('Scanning started');
                scan(true);
            } else {
                setStatus('Scanning stopped');
            }
        });

        panel.querySelector('#aaron-pp-pick').addEventListener('click', handleManualPick);
        updateScanControl();
        return panel;
    }

    function removePanel() {
        currentBest = null;
        const panel = document.getElementById(PANEL_ID);
        if (panel) panel.remove();
    }

    // One tap submits one pick. The result window is then closed automatically,
    // and the button is re-armed for the next user-selected pick.
    function handleManualPick() {
        if (actionBusy) return;
        actionBusy = true;

        const pickButton = document.querySelector('#aaron-pp-pick');
        if (pickButton) {
            pickButton.disabled = true;
            pickButton.style.opacity = '.45';
            pickButton.textContent = 'PICKING…';
        }

        const releaseButton = (message) => {
            actionBusy = false;
            if (message) setStatus(message);
            scan(true);
        };

        const waitUntilResultCloses = (startedAt) => {
            const stillOpen = findOutcomeCloseButton();

            if (stillOpen && Date.now() - startedAt < RESULT_CLOSE_TIMEOUT_MS) {
                // Torn can replace the result element during its close animation.
                // Clicking the currently visible close control again is harmless.
                stillOpen.click();
                setTimeout(() => waitUntilResultCloses(startedAt), 140);
                return;
            }

            setStatus('Ready for next target');
            setTimeout(() => releaseButton(), 220);
        };

        const waitForResult = (startedAt) => {
            const resultClose = findOutcomeCloseButton();

            if (resultClose) {
                setStatus('Result found — closing automatically');
                resultClose.click();
                setTimeout(() => waitUntilResultCloses(Date.now()), 140);
                return;
            }

            if (Date.now() - startedAt >= RESULT_WAIT_TIMEOUT_MS) {
                releaseButton('Result timed out — ready to try again');
                return;
            }

            setTimeout(() => waitForResult(startedAt), 120);
        };

        const submitPick = () => {
            // Refresh the target list after any result window has closed.
            actionBusy = false;
            scan(true);
            actionBusy = true;

            const nativeButton = currentBest && findNativePickButton(currentBest.row);
            if (!nativeButton) {
                releaseButton('Pick button not found — tap again');
                return;
            }

            nativeButton.click();
            setStatus('Pick sent — waiting for result');
            waitForResult(Date.now());
        };

        const staleResult = findOutcomeCloseButton();
        if (staleResult) {
            staleResult.click();

            const waitForStaleResult = (startedAt) => {
                const stillOpen = findOutcomeCloseButton();
                if (stillOpen && Date.now() - startedAt < RESULT_CLOSE_TIMEOUT_MS) {
                    stillOpen.click();
                    setTimeout(() => waitForStaleResult(startedAt), 140);
                    return;
                }

                setTimeout(submitPick, 180);
            };

            waitForStaleResult(Date.now());
            return;
        }

        submitPick();
    }

    function scan(force = false) {
        if (!onPickpocketPage()) {
            removePanel();
            return;
        }

        const panel = makePanel();
        if (!panel) return;
        const skill = getSkill();
        const mode = getMode();
        panel.querySelector('#aaron-pp-skill').textContent = 'CS ' + skill;
        panel.querySelector('#aaron-pp-mode').textContent = mode;
        updateScanControl();

        const status = panel.querySelector('#aaron-pp-status');
        const pickButton = panel.querySelector('#aaron-pp-pick');

        if (!force && !getScanEnabled()) return;
        if (actionBusy) return;

        const outcomeClose = findOutcomeCloseButton();
        if (outcomeClose) {
            status.textContent = 'Result detected — closing…';
            pickButton.disabled = true;
            pickButton.style.opacity = '.45';
            pickButton.textContent = 'CLOSING RESULT…';
            return;
        }

        const rows = findRows();
        if (!rows.length) {
            currentBest = null;
            status.textContent = '0 targets found';
            pickButton.disabled = true;
            pickButton.style.opacity = '.45';
            pickButton.textContent = 'PICK BUTTON NOT FOUND';
            return;
        }

        const targets = [];
        for (const row of rows) {
            const name = getTargetName(row.textContent);
            if (!name) continue;
            const build = findBuild(row);
            const activity = findActivity(row);
            const target = {
                row,
                name,
                build,
                activity,
                tier: getTargetTier(name),
                risk: calculateRisk(name, build, activity),
                skillRating: getSkillRating(name, skill)
            };
            target.score = calculateScore(target, skill, mode);
            targets.push(target);
        }

        const possible = targets.filter(target => target.skillRating !== 'LOCKED');
        possible.sort((a, b) => b.score - a.score);
        const best = possible[0] || null;
        currentBest = best;

        if (previousBest && (!best || previousBest !== best.row)) previousBest.style.boxShadow = '';
        for (const target of targets) paintRow(target, Boolean(best && target.row === best.row));
        previousBest = best ? best.row : null;

        if (!best) {
            pickButton.disabled = true;
            pickButton.style.opacity = '.45';
            pickButton.textContent = 'NO RECOMMENDED TARGET';
            status.textContent = 'No recommended target';
            return;
        }

        status.textContent = mode + ' • BEST: ' + best.name + ' • Risk ' + best.risk;
        const nativeButton = findNativePickButton(best.row);
        if (nativeButton) {
            pickButton.disabled = false;
            pickButton.style.opacity = '1';
            pickButton.textContent = 'PICK BEST • ' + best.name;
        } else {
            pickButton.disabled = true;
            pickButton.style.opacity = '.45';
            pickButton.textContent = 'PICK BUTTON NOT FOUND';
        }
    }

    updateScanTimer();
    setTimeout(() => scan(true), 700);
})();
