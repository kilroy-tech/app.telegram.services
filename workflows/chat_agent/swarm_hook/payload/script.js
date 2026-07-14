/**
 * telegram.services/chat_agent/swarm_hook.js - preflight/postflight functions for telegram.services/chat_agent/swarm_hook
 * @module telegram.services/chat_agent/swarm_hook
 * @file telegram.services/chat_agent/swarm_hook preflight/postflight implementation
 * @author system
 * @copyright Copyright ©2025, Concluent Systems, LLC. All rights reserved.
 */
"use strict";
const MODULE_NAME = "workflow:telegram.services/chat_agent/swarm_hook";
const debug = require('debug')(MODULE_NAME);
debug.log = console.info.bind(console); //https://github.com/visionmedia/debug#readme
const path       = require("path");
const Promise = require("bluebird"); // jshint ignore:line
const appRoot = global.REBAR_NAMESPACE.__base; //require ('app-root-path');
const { streamApi } = require("@grammyjs/stream");
const telegramifyMarkdown = require('telegramify-markdown');
const { Acquire, Release } = require(path.join(appRoot, "modules/util/critical_section"));

const THINKING_PHASE_VALUES = new Set(["START", "DELTA", "END"]);
const THINKING_HEADER = "**Thinking...**";
const TELEGRAM_TEXT_HARD_LIMIT = 4096;
const TELEGRAM_RICH_HARD_LIMIT = 32768;
const THINKING_TEXT_SAFE_LIMIT = 3000;
const THINKING_RICH_STREAM_SAFE_LIMIT = 30000;

function _isMessageNotModifiedError(err) {
    const text = (err && (err.description || err.message || err.toString))
        ? String(err.description || err.message || err.toString())
        : "";
    return text.toLowerCase().includes("message is not modified");
}

function _isMessageTooLongError(err) {
    const text = (err && (err.description || err.message || err.toString))
        ? String(err.description || err.message || err.toString())
        : "";
    return text.toLowerCase().includes("message is too long");
}

function _isMessageEditTargetMissingError(err) {
    const text = (err && (err.description || err.message || err.toString))
        ? String(err.description || err.message || err.toString())
        : "";
    const lower = text.toLowerCase();
    return lower.includes("message to edit not found") || lower.includes("message can't be edited");
}

function _splitTextIntoChunks(text, maxChars) {
    const input = (text || "").toString();
    const limit = Math.max(1, Math.min(maxChars || THINKING_TEXT_SAFE_LIMIT, TELEGRAM_TEXT_HARD_LIMIT));
    const chunks = [];
    let remaining = input;

    while (remaining.length > limit) {
        let cut = remaining.lastIndexOf("\n", limit);
        if (cut < Math.floor(limit * 0.5)) {
            cut = remaining.lastIndexOf(" ", limit);
        }
        if (cut <= 0) {
            cut = limit;
        }
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
        if (remaining.startsWith("\n") || remaining.startsWith(" ")) {
            remaining = remaining.slice(1);
        }
    }

    if (remaining.length > 0) {
        chunks.push(remaining);
    }
    return chunks;
}

function _appendThinkingDelta(existingText, deltaText) {
    const left = (existingText === null || existingText === undefined) ? "" : String(existingText);
    const right = (deltaText === null || deltaText === undefined) ? "" : String(deltaText);
    if (!left) return right;
    if (!right) return left;

    const leftEndsWithWhitespace = /\s$/.test(left);
    const rightStartsWithWhitespace = /^\s/.test(right);
    const seam = (leftEndsWithWhitespace || rightStartsWithWhitespace) ? "" : " ";
    return `${left}${seam}${right}`;
}

function _parseThinkingCommand(text) {
    const raw = (text || "").toString().trim();
    const match = raw.match(/^\/kilroy\.ai\.thinking\s+([A-Za-z_]+)(?:\s+(.+))?\s*$/i);
    if (!match) return null;

    const phase = (match[1] || "").toUpperCase();
    if (!THINKING_PHASE_VALUES.has(phase)) return null;

    let payload = {};
    const payloadText = (match[2] || "").trim();
    if (payloadText) {
        try {
            payload = JSON.parse(payloadText);
        } catch (e) {
            payload = {};
        }
    }

    return {
        phase,
        turn_id: (payload.turn_id || payload.turn || "").toString().trim(),
        text: (payload.text || payload.delta || "").toString(),
    };
}

function _isAcceptedSender(from, agentFilter) {
    const sender = (from || "").toString();
    const filter = (agentFilter || "*").toString().trim();

    if (!filter || filter === "*") return true;

    if (filter.startsWith("!")) {
        const excluded = filter.slice(1).trim();
        if (!excluded) return true;
        return sender !== excluded;
    }

    return sender === filter;
}


function _createTextQueue() {
    const items = [];
    let done = false;
    let wake = null;

    return {
        push(chunk) {
            if (done || !chunk) return;
            items.push(chunk);
            if (wake) {
                const notify = wake;
                wake = null;
                notify();
            }
        },
        end() {
            done = true;
            if (wake) {
                const notify = wake;
                wake = null;
                notify();
            }
        },
        async *stream() {
            while (true) {
                if (items.length > 0) {
                    yield items.shift();
                    continue;
                }
                if (done) break;
                await new Promise((resolve) => { wake = resolve; });
            }
        }
    };
}

function _nextThinkingDraftId(botData, chat_id) {
    botData.thinking_draft_counter = (botData.thinking_draft_counter || 0) + 1;
    const base = Math.floor(Date.now() / 1000) & 0x7fffff;
    const chatPart = Math.abs(Number(chat_id) || 0) & 0x3ff;
    const seq = botData.thinking_draft_counter & 0xff;
    return (base << 12) | (chatPart << 8) | seq;
}

async function _sendMarkdownOrPlain(botData, chat_id, text) {
    try {
        const mdText = telegramifyMarkdown(text || "");
        return await botData.bot.api.sendMessage(chat_id, mdText, { parse_mode: "MarkdownV2" });
    } catch (err) {
        if (_isMessageTooLongError(err)) {
            throw err;
        }
        debug(`markdown send fallback: ${err}`);
        return botData.bot.api.sendMessage(chat_id, text || "", {});
    }
}

async function _editMarkdownOrPlain(botData, chat_id, message_id, text) {
    try {
        const mdText = telegramifyMarkdown(text || "");
        return await botData.bot.api.editMessageText(chat_id, message_id, mdText, { parse_mode: "MarkdownV2" });
    } catch (err) {
        if (_isMessageNotModifiedError(err)) {
            debug(`markdown edit no-op (not modified) msg_id=${message_id}`);
            return null;
        }
        if (_isMessageTooLongError(err)) {
            throw err;
        }
        debug(`markdown edit fallback: ${err}`);
        try {
            return await botData.bot.api.editMessageText(chat_id, message_id, text || "", {});
        } catch (plainErr) {
            if (_isMessageNotModifiedError(plainErr)) {
                debug(`plain edit no-op (not modified) msg_id=${message_id}`);
                return null;
            }
            if (_isMessageTooLongError(plainErr)) {
                throw plainErr;
            }
            throw plainErr;
        }
    }
}

async function _upsertThinkingFallbackMessages(botData, chat_id, session) {
    const text = session.full_text || "";
    if (!text) return;

    const chunks = _splitTextIntoChunks(text, THINKING_TEXT_SAFE_LIMIT);
    if (!Array.isArray(session.fallback_message_ids)) {
        session.fallback_message_ids = [];
    }
    if (!Array.isArray(session.fallback_chunk_texts)) {
        session.fallback_chunk_texts = [];
    }
    const ids = session.fallback_message_ids;

    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const existingId = ids[i];

        if (!existingId) {
            const sent = await _sendMarkdownOrPlain(botData, chat_id, chunk);
            ids[i] = sent && sent.message_id;
            continue;
        }

        try {
            await _editMarkdownOrPlain(botData, chat_id, existingId, chunk);
        } catch (err) {
            if (_isMessageEditTargetMissingError(err)) {
                const sent = await _sendMarkdownOrPlain(botData, chat_id, chunk);
                ids[i] = sent && sent.message_id;
            } else {
                throw err;
            }
        }
    }

    if (ids.length > chunks.length) {
        const stale = ids.slice(chunks.length);
        ids.length = chunks.length;
        for (const message_id of stale) {
            if (!message_id) continue;
            try {
                await botData.bot.api.deleteMessage(chat_id, message_id);
            } catch (err) {
                debug(`thinking_cleanup_stale_delete_failed message_id=${message_id} err=${err}`);
            }
        }
    }

    session.fallback_chunk_texts = chunks.slice();
    session.fallback_initialized = true;
    session.fallback_message_id = ids.length > 0 ? ids[ids.length - 1] : null;
}

async function _appendThinkingFallbackDelta(botData, chat_id, session, deltaText) {
    const delta = (deltaText || "").toString();
    if (!delta) return;

    if (!Array.isArray(session.fallback_message_ids)) {
        session.fallback_message_ids = [];
    }
    if (!Array.isArray(session.fallback_chunk_texts)) {
        session.fallback_chunk_texts = [];
    }

    const ids = session.fallback_message_ids;
    const chunkTexts = session.fallback_chunk_texts;
    const changed = new Set();
    let remaining = delta;

    while (remaining.length > 0) {
        if (chunkTexts.length < 1 || chunkTexts[chunkTexts.length - 1].length >= THINKING_TEXT_SAFE_LIMIT) {
            chunkTexts.push("");
            ids.push(null);
        }

        const idx = chunkTexts.length - 1;
        const room = THINKING_TEXT_SAFE_LIMIT - chunkTexts[idx].length;
        if (room <= 0) {
            continue;
        }

        const part = remaining.slice(0, room);
        chunkTexts[idx] += part;
        remaining = remaining.slice(part.length);
        changed.add(idx);
    }

    const ordered = Array.from(changed).sort((a, b) => a - b);
    for (const idx of ordered) {
        const chunk = chunkTexts[idx] || "";
        const existingId = ids[idx];
        if (!existingId) {
            const sent = await _sendMarkdownOrPlain(botData, chat_id, chunk);
            ids[idx] = sent && sent.message_id;
            continue;
        }

        try {
            await _editMarkdownOrPlain(botData, chat_id, existingId, chunk);
        } catch (err) {
            if (_isMessageEditTargetMissingError(err)) {
                const sent = await _sendMarkdownOrPlain(botData, chat_id, chunk);
                ids[idx] = sent && sent.message_id;
            } else {
                throw err;
            }
        }
    }

    session.fallback_initialized = true;
    session.fallback_message_id = ids.length > 0 ? ids[ids.length - 1] : null;
}

async function _sendThinkingHeader(botData, chat_id, key) {
    try {
        const sent = await _sendMarkdownOrPlain(botData, chat_id, THINKING_HEADER);
        return sent;
    } catch (err) {
        debug(`thinking header send failed for ${key}: ${err}`);
        return null;
    }
}

function _buildThinkingSessionKey(chat_id, turn_id, fallback_seed) {
    const tid = turn_id || `thinking_${fallback_seed || "default"}`;
    return `${chat_id}:${tid}`;
}

function _ensureThinkingSessionMap(botData) {
    if (!botData.thinking_sessions || typeof botData.thinking_sessions !== "object") {
        botData.thinking_sessions = {};
    }
    return botData.thinking_sessions;
}

function _cleanupThinkingSession(botData, key) {
    const sessions = _ensureThinkingSessionMap(botData);
    delete sessions[key];
}

async function _deleteThinkingMessages(botData, chat_id, session, key) {
    if (!session) return;

    const ids = [];
    if (session.header_message_id) ids.push(session.header_message_id);
    if (session.fallback_message_id) ids.push(session.fallback_message_id);
    if (Array.isArray(session.fallback_message_ids) && session.fallback_message_ids.length > 0) {
        ids.push(...session.fallback_message_ids);
    }
    if (session.stream_message_id) ids.push(session.stream_message_id);

    if (ids.length === 0) {
        return;
    }

    const uniqueIds = Array.from(new Set(ids));
    for (const message_id of uniqueIds) {
        try {
            await botData.bot.api.deleteMessage(chat_id, message_id);
            debug(`thinking_cleanup_deleted key=${key} message_id=${message_id}`);
        } catch (err) {
            debug(`thinking_cleanup_delete_failed key=${key} message_id=${message_id} err=${err}`);
        }
    }
}

async function _startThinkingStream(botData, chat_id, key, session) {
    try {
        const streamer = streamApi(botData.bot.api.raw);
        const draft_id = _nextThinkingDraftId(botData, chat_id);
        const finalMsg = await streamer.streamMarkdown(chat_id, draft_id, session.queue.stream());
        session.stream_message_id = finalMsg && finalMsg.message_id ? finalMsg.message_id : null;
        session.stream_completed = true;
        if (session.done) {
            await _deleteThinkingMessages(botData, chat_id, session, key);
            _cleanupThinkingSession(botData, key);
        }
    } catch (err) {
        debug(`streamMarkdown fallback for ${key}: ${err}`);
        session.mode = "fallback";
        session.stream_completed = true;
        try {
            await _upsertThinkingFallbackMessages(botData, chat_id, session);
        } catch (fallbackErr) {
            debug(`fallback send failed for ${key}: ${fallbackErr}`);
        }
        if (session.done) {
            await _deleteThinkingMessages(botData, chat_id, session, key);
            _cleanupThinkingSession(botData, key);
        }
    }
}

async function _handleThinkingMessage(botData, chat_id, from, thinking) {
    const sessions = _ensureThinkingSessionMap(botData);
    const key = _buildThinkingSessionKey(chat_id, thinking.turn_id, from);
    let session = sessions[key];

    if (thinking.phase === "START") {
        if (session) {
            session.done = true;
            if (session.queue) session.queue.end();
        }
        session = null;
    }

    if (!session && thinking.phase === "END") {
        return;
    }

    if (!session) {
        session = {
            mode: "stream",
            queue: _createTextQueue(),
            full_text: "",
            done: false,
            fallback_message_id: null,
            fallback_message_ids: [],
            fallback_chunk_texts: [],
            fallback_initialized: false,
            stream_message_id: null,
            stream_completed: false,
            header_sent: false,
            header_message_id: null,
        };
        sessions[key] = session;
        const headerSent = await _sendThinkingHeader(botData, chat_id, key);
        session.header_sent = true;
        session.header_message_id = headerSent && headerSent.message_id ? headerSent.message_id : null;
        session.stream_promise = _startThinkingStream(botData, chat_id, key, session);
    }

    if (thinking.text) {
        const priorText = session.full_text || "";
        const nextText = _appendThinkingDelta(priorText, thinking.text);
        const appendedSegment = nextText.slice(priorText.length);
        session.full_text = nextText;
        if (session.mode === "stream") {
            if (session.full_text.length <= THINKING_RICH_STREAM_SAFE_LIMIT) {
                if (appendedSegment) {
                    session.queue.push(appendedSegment);
                }
            } else {
                session.mode = "fallback";
                session.queue.end();
                if (session.stream_promise) {
                    await session.stream_promise;
                }
                if (session.stream_message_id) {
                    try {
                        await botData.bot.api.deleteMessage(chat_id, session.stream_message_id);
                    } catch (err) {
                        debug(`thinking_stream_message_delete_failed key=${key} message_id=${session.stream_message_id} err=${err}`);
                    }
                    session.stream_message_id = null;
                }
                await _upsertThinkingFallbackMessages(botData, chat_id, session);
            }
        } else {
            if (!session.fallback_initialized) {
                await _upsertThinkingFallbackMessages(botData, chat_id, session);
            } else if (appendedSegment) {
                await _appendThinkingFallbackDelta(botData, chat_id, session, appendedSegment);
            }
        }
    }

    if (thinking.phase === "END") {
        session.done = true;
        if (session.mode === "stream") {
            session.queue.end();
            if (!session.stream_completed && session.stream_promise) {
                await session.stream_promise;
            } else {
                await _deleteThinkingMessages(botData, chat_id, session, key);
                _cleanupThinkingSession(botData, key);
            }
        } else {
            await _upsertThinkingFallbackMessages(botData, chat_id, session);
            await _deleteThinkingMessages(botData, chat_id, session, key);
            _cleanupThinkingSession(botData, key);
        }
    }
}

async function _sendNormalMessage(botData, chat_id, use_markdown, text) {
    const rawText = (text || "").toString();
    const chunks = _splitTextIntoChunks(rawText, THINKING_TEXT_SAFE_LIMIT);
    const semaID = `telegram_send_${chat_id}`;

    await Acquire(semaID);
    debug(`acquired ${semaID}`);

    try {
        for (const chunk of chunks) {
            if (!chunk) continue;

            if (use_markdown) {
                try {
                    const mdChunk = telegramifyMarkdown(chunk);
                    await botData.bot.api.sendMessage(chat_id, mdChunk, { parse_mode: "MarkdownV2" });
                    continue;
                } catch (err) {
                    debug(`grammy reject markdown chunk ${err}`);
                }
            }

            // Fallback to plain text for this chunk; split again at hard limit as final guardrail.
            const plainChunks = _splitTextIntoChunks(chunk, TELEGRAM_TEXT_HARD_LIMIT);
            for (const plainChunk of plainChunks) {
                if (!plainChunk) continue;
                await botData.bot.api.sendMessage(chat_id, plainChunk, {});
            }
        }
    } finally {
        await Release(semaID);
        debug(`released ${semaID}`);
    }
}

//-----------------------------------------------------

async function preflight(authData, wfProxy) {
	//called before the workflow steps run
//    debug ("preflight");
    try {
        let wha = wfProxy.getGlobalValue ("webhook_args") || {};
        let data = JSON.parse (wha.data || "{}");
        let from = data.from || "*";
        let ta_alias = wfProxy.getGlobalValue("ta_alias");
        let ta_agent_from = wfProxy.getGlobalValue("ta_agent_from");
        let botData = global.REBAR_NAMESPACE.__telegram [ta_alias];

        if (!botData || !botData.bot) {
            debug(`telegram bot not initialized for alias ${ta_alias}`);
            return Promise.resolve({success: true});
        }

        let chat_id = botData.chat_id;
        
        let use_markdown = botData.use_markdown;

        const argsList = Array.isArray(data.args) ? data.args : [];
        if (!_isAcceptedSender(from, ta_agent_from)) {
            debug (`not sending msg to telegram from: ${from}, filter: ${ta_agent_from}`);
            return Promise.resolve({success: true});
        }
        
        for (const msgObj of argsList) {
            const text = (msgObj && msgObj.text) ? String(msgObj.text) : "";
            if (!text) continue;

            const thinking = _parseThinkingCommand(text);
            if (thinking) {
                const thinkingLockKey = `telegram_thinking_${chat_id}_${thinking.turn_id || from}`;
                await Acquire(thinkingLockKey);
                try {
                    await _handleThinkingMessage(botData, chat_id, from, thinking);
                } finally {
                    await Release(thinkingLockKey);
                }
                wfProxy.setGlobalValue("ta_msg", `Thinking ${thinking.phase}${thinking.turn_id ? (" " + thinking.turn_id) : ""}`);
                continue;
            }

            // Suppress slash commands we do not explicitly support in Telegram.
            if (text.trim().startsWith("/")) {
                wfProxy.setGlobalValue("ta_msg", "Ignored unsupported slash command");
                continue;
            }

            wfProxy.setGlobalValue ("ta_msg", `Sending: ${text}`);
            await _sendNormalMessage(botData, chat_id, use_markdown, text);
        }

        return Promise.resolve({success: true});
            

    }
    catch (err) {
        debug (`error sending ${err}`);
        wfProxy.setGlobalValue ("ta_msg", `Error sending: ${err}`);
    }
    
    
	return Promise.resolve({success: true});
}

//-----------------------------------------------------

function begin (authData, wfProxy, step, theForm) {
	//called to load/preconfigure/define a form by ID passed in step.args.formID
    debug ("begin formID:" + step.args.formID);
    return new Promise( function(resolve, reject){
        try {
			var formObj = theForm; //any form from the workflow def is passed here
			var formData = wfProxy.getGlobalValue ("formData"); // key/value object overriding field defaults
            var formErrors = wfProxy.getGlobalValue('formErrors'); // errors from a previous form submission

			// do work here to pre-populate fields, or to generate dynamic forms, etc.
			
            return resolve({
                success: true,
                args: {
                    form: formObj,
                    formValues: formData,
                    formErrors: formErrors
                }
            });
        } catch(err){
            debug ("begin err: " + err);
            return reject(err);
        }
    });
}

//-----------------------------------------------------

function end (authData, wfProxy, step, formData) {
	// called to postprocess form data, persist it, etc. before returning results to workflow
    var result = {
            success: true,
            path: wfProxy.PATH_SUCCESS,
            args: formData
        };
    debug ("end: " + step.args.formID);
    
    //do whatever field validation, database saves, etc. required, then return result
    
    return Promise.resolve(result);
}

//-----------------------------------------------------

function postflight(authData, wfProxy) {
    return Promise.resolve({success: true});
}


//-----------------------------------------------------

function terminate (authData, wfProxy) {
	//perform any cleanup or rollback required if a workflow is terminated without completing
	try {
		debug ("terminate");
		return Promise.resolve ({success: true});
	}
	catch (err) {
		debug ("terminate exception : " + JSON.stringify (err));
		return Promise.resolve ({success: false});
	}
}

module.exports = {
    preflight: preflight,
    postflight: postflight,
    begin: begin,
    end: end,
    terminate: terminate
};

