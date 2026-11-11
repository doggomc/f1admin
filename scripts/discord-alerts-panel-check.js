#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const original = Module._load;
const discord = require('discord.js');
let readyDone; const fullyReady = new Promise(resolve => { readyDone = resolve; });
class FakeClient extends EventEmitter {
  constructor() { super(); this.guilds = {cache:new Map()}; this.user = {id:'app',tag:'Bot#0000',setPresence:async()=>{readyDone();}}; }
  login() { return Promise.resolve(); }
  destroy() {}
}
class FakeREST { setToken() { return this; } async put() {} }
Module._load = function(name, parent, main) { if (name === 'discord.js') return {...discord,Client:FakeClient,REST:FakeREST}; return original.apply(this, arguments); };
const bot = require('../bot/discord-bot'); Module._load = original;
(async () => {
  const image = await bot._test.alertsPanelPayload();
  assert.equal(image.embeds,undefined); assert.equal(image.files[0].name,'freef1-alerts-panel.png');
  assert.equal(image.components[0].toJSON().components[0].custom_id,'freef1:alerts');
  assert.deepEqual(image.allowedMentions,{parse:[]});
  const changed = await bot._test.alertsPanelPayload({edit:true});
  assert.deepEqual(changed.embeds,[]); assert.deepEqual(changed.attachments,[]);
  let updated; let resolveEdit; const edited = new Promise(resolve=>{resolveEdit=resolve});
  const message = { attachments: new discord.Collection(), edit:async payload=>{updated=payload; resolveEdit()} };
  const channel = { messages:{fetch:async id=>{assert.equal(id,'old-panel');return message}},send:()=>{throw Error('Should not create a new message')} };
  const guild = {id:'guild',name:'Test',roles:{cache:new discord.Collection()},channels:{cache:new Map([['panel-channel',channel]])}};
  const state = { guilds:{guild:{emojiIds:{},driverRoles:{},panels:{alerts:{channelId:'panel-channel',messageId:'old-panel'}},alerts:{channelId:'real-alerts',roleId:'configured-role'},sent:{},config:{}}} };
  const instance = bot.start({ownerId:'owner',token:'test',siteUrl:'https://freef1-live.vercel.app',readLocalJson:()=>state,writeLocalJson:()=>{},log:()=>{}});
  instance.client.guilds.cache.set('guild',guild);
  try {
    instance.client.emit(discord.Events.ClientReady);
    await Promise.race([edited,new Promise((_,reject)=>setTimeout(()=>reject(Error('old panel not updated')),5000))]);
    await Promise.race([fullyReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('startup did not finish')),5000))]);
    assert.equal(updated.files[0].name,'freef1-alerts-panel.png');
    assert.deepEqual(updated.embeds,[]);assert.deepEqual(updated.attachments,[]);
    assert.equal(updated.components[0].toJSON().components[0].custom_id,'freef1:alerts');
    assert.deepEqual(state.guilds.guild.alerts,{channelId:'real-alerts',roleId:'configured-role'});
    assert.deepEqual(state.guilds.guild.panels.alerts,{channelId:'panel-channel',messageId:'old-panel'});
    console.log('Stream Alerts panel: PNG, toggle, in-place migration and saved settings passed');
  } finally { instance.stop(); }
})().catch(error=>{console.error(error);process.exitCode=1});
