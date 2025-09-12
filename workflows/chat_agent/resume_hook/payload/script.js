/**
 * telegram.services/chat_agent/resume_hook.js - preflight/postflight functions for telegram.services/chat_agent/resume_hook
 * @module telegram.services/chat_agent/resume_hook
 * @file telegram.services/chat_agent/resume_hook preflight/postflight implementation
 * @author system
 * @copyright Copyright ©2024, Concluent Systems, LLC. All rights reserved.
 */
"use strict";
const MODULE_NAME = "workflow:telegram.services/chat_agent/resume_hook";
const debug = require('debug')(MODULE_NAME);
debug.log = console.info.bind(console); //https://github.com/visionmedia/debug#readme
const Promise = require("bluebird"); // jshint ignore:line
const appRoot = global.REBAR_NAMESPACE.__base; //require ('app-root-path');
const { Bot } = require("grammy");
const request 	= require ("request-promise");
const _ 		= require('lodash');

//-----------------------------------------------------

function preflight(authData, wfProxy) {
	//called before the workflow steps run
    debug ("preflight");
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

function _processMessage (ctx, bot) {
    debug (`_processMessage for ${bot.alias}`);
    let KilroyURL = `http://localhost:3000/api/v1/pd/webhook/API_TOKEN/${bot.alias}`;
    let text = ctx.message.text;
    let chat_id = ctx.chatId;
    
    //need to sync up the chatId with the pd context
    let options = {
        method: "POST",
        uri: KilroyURL + "/set_chat_id_hook",
        json: true,
        headers: {"Content-Type":"application/json"}
    };
    
    let res = Promise.resolve (true); //dummy results if we don't need to set chat_id
    
    if (bot.chat_id == 0) {
        bot.chat_id = chat_id;
        options.body = {chat_id: chat_id};
        res = request (options);
    }

    //now send the text to the swarm
    options.body = {text:text};
    options.uri = KilroyURL + "/swarm_send_hook";
    
    return res.then (x => {
        return request (options).then ((body)=>{
            //debug ("received HTTP response:\n" + JSON.stringify (body, null, 4));
            console.log (`Telegram Bot sent message: ${text}`);
            return Promise.resolve (true);
        });
    })
    .catch ((err)=>{
        debug (`Request ERROR: ${err}`);
        return Promise.resolve(false);
    });
    
}

//-----------------------------------------------------

function postflight(authData, wfProxy) {
    debug ("postflight");
    // the following is a SPECIAL EXCEPTION! The global Rebar/Kilroy namespace should be used only when no other mechanism is available for persisting globals!!
    try {
        // make our global storage
        if (global.REBAR_NAMESPACE.__telegram == undefined) {
            global.REBAR_NAMESPACE.__telegram = {};
        }
        //try to open up a new bot for this pd_alias
        let wha = wfProxy.getGlobalValue ("webhook_args");
        debug (`wha: ${JSON.stringify (wha, null, 4)}`);
        
        let ta_alias = wha.agent_alias || wfProxy.getGlobalValue ("ta_alias") || "undefined_bot";
        let ta_rec_swarm = wha.agent_rec_swarm || wfProxy.getGlobalValue ("ta_rec_swarm") ;
        let ta_send_swarm = wha.agent_send_swarm || wfProxy.getGlobalValue ("ta_send_swarm") ;
        
        let wf_args = {};
        let ta_use_markdown = false;
        let ta_api_key = "";
        let ta_active_chat_id = "";
        
        try {
            wf_args = JSON.parse (wha.wf_webhook_args);
            ta_use_markdown = wf_args.markdown || wfProxy.getGlobalValue ("ta_use_markdown");
            ta_api_key = wf_args.bot_key || wfProxy.getGlobalValue ("ta_api_key") || "";
            ta_active_chat_id = wf_args.chat_id || wfProxy.getGlobalValue ("ta_active_chat_id") || 0;
        }
        catch (oops) {
            debug (`error reading wf_webhook args: ${oops}`);
        }
        
        let new_bot = {
            bot: null,
            chat_id: ta_active_chat_id,
            rec_swarm: ta_rec_swarm,
            send_swarm: ta_send_swarm,
            alias: ta_alias,
            use_markdown: ta_use_markdown
        };
        
        debug (`@@@ starting bot ${JSON.stringify(new_bot, null, 4)}`);
        
        new_bot.bot = new Bot (ta_api_key);
        
        global.REBAR_NAMESPACE.__telegram [ta_alias] = new_bot;
        
        if (new_bot.bot !== undefined) {
            new_bot.bot.on ("message", (ctx) => {
                _processMessage (ctx, new_bot);
            });
            
            new_bot.bot.start();
        }
        
        
    }
    catch (err) {
        debug (`postflight err ${err}`);
    }
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

