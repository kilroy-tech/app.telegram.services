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

function _isMessageNotModifiedError(err) {
    const text = (err && (err.description || err.message || err.toString))
        ? String(err.description || err.message || err.toString())
        : "";
    return text.toLowerCase().includes("message is not modified");
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

function _previewText(text, maxLen) {
    const limit = Number(maxLen) > 0 ? Number(maxLen) : 140;
    const raw = (text || "").toString().replace(/\s+/g, " ").trim();
    if (raw.length <= limit) return raw;
    return `${raw.slice(0, limit)}...`;
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

function _senderMatchDetails(from, agentFilter) {
    const sender = (from || "").toString();
    const filter = (agentFilter || "*").toString().trim();

    if (!filter || filter === "*") {
        return {
            accepted: true,
            mode: "wildcard",
            sender,
            filter,
            expected: "*",
            reason: "wildcard accepts all senders"
        };
    }

    if (filter.startsWith("!")) {
        const excluded = filter.slice(1).trim();
        const accepted = !excluded || sender !== excluded;
        return {
            accepted,
            mode: "not-agent",
            sender,
            filter,
            expected: excluded || "(empty)",
            reason: accepted ? "sender is not excluded" : "sender matched excluded alias"
        };
    }

    const accepted = sender === filter;
    return {
        accepted,
        mode: "exact",
        sender,
        filter,
        expected: filter,
        reason: accepted ? "sender matched exact alias" : "sender did not match exact alias"
    };
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
        debug(`markdown edit fallback: ${err}`);
        try {
            return await botData.bot.api.editMessageText(chat_id, message_id, text || "", {});
        } catch (plainErr) {
            if (_isMessageNotModifiedError(plainErr)) {
                debug(`plain edit no-op (not modified) msg_id=${message_id}`);
                return null;
            }
            throw plainErr;
        }
    }
}

async function _upsertThinkingFallbackMessage(botData, chat_id, session) {
    const text = session.full_text || "";
    if (!text) return;

    if (!session.fallback_message_id) {
        const sent = await _sendMarkdownOrPlain(botData, chat_id, text);
        session.fallback_message_id = sent && sent.message_id;
        return;
    }

    await _editMarkdownOrPlain(botData, chat_id, session.fallback_message_id, text);
}

async function _sendThinkingHeader(botData, chat_id, key) {
    try {
        const sent = await _sendMarkdownOrPlain(botData, chat_id, THINKING_HEADER);
        debug(`thinking_header_sent key=${key} msg_id=${sent && sent.message_id ? sent.message_id : ""}`);
        return sent;
    } catch (err) {
        debug(`thinking_header_send_failed key=${key} err=${err}`);
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
    if (session.stream_message_id) ids.push(session.stream_message_id);

    if (ids.length === 0) {
        debug(`thinking_cleanup_no_messages key=${key}`);
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
        debug(`thinking_stream_complete key=${key} message_id=${session.stream_message_id || ""} done=${session.done}`);
        if (session.done) {
            await _deleteThinkingMessages(botData, chat_id, session, key);
            _cleanupThinkingSession(botData, key);
        }
    } catch (err) {
        debug(`streamMarkdown fallback for ${key}: ${err}`);
        session.mode = "fallback";
        session.stream_completed = true;
        try {
            await _upsertThinkingFallbackMessage(botData, chat_id, session);
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
        debug(`thinking_end_without_session key=${key}`);
        return;
    }

    if (!session) {
        session = {
            mode: "stream",
            queue: _createTextQueue(),
            full_text: "",
            done: false,
            fallback_message_id: null,
            stream_message_id: null,
            stream_completed: false,
            header_sent: false,
            header_message_id: null,
        };
        sessions[key] = session;
        const headerSent = await _sendThinkingHeader(botData, chat_id, key);
        session.header_sent = true;
        session.header_message_id = headerSent && headerSent.message_id ? headerSent.message_id : null;
        debug(`thinking_session_start key=${key} header_len=${THINKING_HEADER.length}`);
        session.stream_promise = _startThinkingStream(botData, chat_id, key, session);
    }

    if (thinking.text) {
        session.full_text += thinking.text;
        if (session.mode === "stream") {
            session.queue.push(thinking.text);
        } else {
            await _upsertThinkingFallbackMessage(botData, chat_id, session);
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
            await _upsertThinkingFallbackMessage(botData, chat_id, session);
            await _deleteThinkingMessages(botData, chat_id, session, key);
            _cleanupThinkingSession(botData, key);
        }
    }
}

async function _sendNormalMessage(botData, chat_id, use_markdown, text) {
    const parse_mode = use_markdown ? { parse_mode: "MarkdownV2" } : {};
    const msg = use_markdown ? telegramifyMarkdown(text || "") : (text || "");
    const semaID = `telegram_send_${chat_id}`;

    await Acquire(semaID);
    debug(`acquired ${semaID}`);

    try {
        await botData.bot.api.sendMessage(chat_id, msg, parse_mode);
    } catch (err) {
        debug(`grammy reject ${err}`);
        await botData.bot.api.sendMessage(chat_id, text || "", {});
    } finally {
        await Release(semaID);
        debug(`released ${semaID}`);
    }
}

//-----------------------------------------------------

async function preflight(authData, wfProxy) {
	//called before the workflow steps run
    debug ("preflight");
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
        const matchInfo = _senderMatchDetails(from, ta_agent_from);
        debug(`sender_filter mode=${matchInfo.mode} sender="${matchInfo.sender}" filter="${matchInfo.filter}" expected="${matchInfo.expected}" accepted=${matchInfo.accepted} reason="${matchInfo.reason}" args_count=${argsList.length}`);

        if (!matchInfo.accepted) {
            const rejectedPreview = (argsList.length > 0 && argsList[0] && argsList[0].text) ? _previewText(argsList[0].text, 180) : "";
            debug(`sender_filter_reject sender="${matchInfo.sender}" filter="${matchInfo.filter}" first_message_preview="${rejectedPreview}"`);
            return Promise.resolve({success: true});
        }
        
        debug (`@@@ send to telegram: ${ta_alias}, md ${use_markdown}\n${JSON.stringify(wha,null,4)}`)

        for (const msgObj of argsList) {
            const text = (msgObj && msgObj.text) ? String(msgObj.text) : "";
            if (!text) continue;

            debug(`message_in sender="${from}" preview="${_previewText(text, 180)}"`);

            const thinking = _parseThinkingCommand(text);
            if (thinking) {
                debug(`message_route route=thinking phase=${thinking.phase} turn_id="${thinking.turn_id}" delta_len=${(thinking.text || "").length}`);
                await _handleThinkingMessage(botData, chat_id, from, thinking);
                wfProxy.setGlobalValue("ta_msg", `Thinking ${thinking.phase}${thinking.turn_id ? (" " + thinking.turn_id) : ""}`);
                continue;
            }

            // Suppress slash commands we do not explicitly support in Telegram.
            if (text.trim().startsWith("/")) {
                debug(`message_route route=slash_reject sender="${from}" preview="${_previewText(text, 180)}"`);
                wfProxy.setGlobalValue("ta_msg", "Ignored unsupported slash command");
                continue;
            }

            debug(`message_route route=normal_send sender="${from}" markdown=${use_markdown}`);
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
    debug ("postflight");
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

