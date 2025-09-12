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
const Promise = require("bluebird"); // jshint ignore:line
const appRoot = global.REBAR_NAMESPACE.__base; //require ('app-root-path');
const { Bot } = require("grammy");
const telegramifyMarkdown = require('telegramify-markdown');

//-----------------------------------------------------

function preflight(authData, wfProxy) {
	//called before the workflow steps run
    debug ("preflight");
    try {
        let wha = wfProxy.getGlobalValue ("webhook_args");
        let data = JSON.parse (wha.data);
        let from = data.from || "*";
        let ta_alias = wfProxy.getGlobalValue("ta_alias");
        let ta_agent_from = wfProxy.getGlobalValue("ta_agent_from");
        let bot = global.REBAR_NAMESPACE.__telegram [ta_alias];
        let chat_id = bot.chat_id;
        
        let use_markdown = bot.use_markdown;
        let parse_mode = {};

        if (from != ta_agent_from && ta_agent_from != "*") { //doesn't match who we are listening for... don't send to telegram
debug (`not sending msg to telegram from: ${from}`);
            return Promise.resolve({success: true});
        }

        if (use_markdown) {
            parse_mode = { parse_mode: "MarkdownV2" };
        }
        
        debug (`@@@ send to telegram: ${ta_alias}\n${JSON.stringify(wha,null,4)}`)
        
        let text = data.args[0].text;
        wfProxy.setGlobalValue ("ta_msg", `Sending: ${text}`);
//        msg = msg.replace(/([|{\[\]*_~}+)(#>!=\-.])/gm, '\\$1');
        let msg = use_markdown ? telegramifyMarkdown (text) : text;
        
        return bot.bot.api.sendMessage(chat_id, msg, parse_mode).then (m=>{
            return Promise.resolve({success: true});
        },
        r=>{ //rejected! revert to just plain text
            debug (`grammy reject ${r}`);
            return bot.bot.api.sendMessage(chat_id, text, {}).then (m=>{
                return Promise.resolve({success: true});
            });
        });
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

