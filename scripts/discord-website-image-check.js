#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const originalLoad = Module._load;
const discord = require('discord.js');
class FakeClient extends EventEmitter { constructor(){super();this.guilds={cache:new Map()}} login(){return Promise.resolve()} destroy(){} }
Module._load = function(name,parent,main){if(name==='discord.js')return {...discord,Client:FakeClient};return originalLoad.apply(this,arguments)};
const bot = require('../bot/discord-bot'); Module._load=originalLoad;
(async()=>{
  const instance=bot.start({ownerId:'owner',token:'test',siteUrl:'https://freef1-live.vercel.app',discordInvite:'https://discord.gg/KYXHCAzhN4',log:()=>{}});
  try {
    let resolveReply;const done=new Promise(r=>resolveReply=r);let deferred=false, result;
    instance.client.emit(discord.Events.InteractionCreate,{
      isButton:()=>false,isChatInputCommand:()=>true,commandName:'website',user:{id:'anyone'},guild:null,
      deferReply:async()=>{deferred=true},editReply:async payload=>{result=payload;resolveReply()},
    });
    await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(Error('website command timed out')),5000))]);
    assert(deferred);assert.equal(result.embeds,undefined);assert.equal(result.files[0].name,'freef1-website.png');
    assert(result.files[0].attachment.length<16*1024,'PNG should remain smaller than 16 KiB');
    assert.equal(result.files[0].attachment.subarray(1,4).toString(),'PNG');
    assert.deepEqual(result.allowedMentions,{parse:[]});
    const buttons=result.components[0].toJSON().components;
    assert.equal(buttons[0].url,'https://freef1-live.vercel.app');assert.equal(buttons[1].url,'https://discord.gg/KYXHCAzhN4');
    console.log(`/website: public command, PNG (${result.files[0].attachment.length} bytes), correct links, no embed passed`);
  } finally {instance.stop()}
})().catch(e=>{console.error(e);process.exitCode=1});
