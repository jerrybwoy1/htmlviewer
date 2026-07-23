import {Storage} from './storage.js';
export function loadProviderSettings(){return Storage.providerSettings()}
export function saveProviderSettings(next){Storage.saveProviders(next);return next}
export function providerSummary(p){const names=[];if(p?.groq?.enabled&&p.groq.key)names.push('Groq');if(p?.google?.enabled&&p.google.key)names.push('Google AI Studio');return names.length?names.join(' + '):'Local / no API';}
export function clearProviderKeys(){const p=Storage.providerSettings();const next={groq:{enabled:false,key:''},google:{enabled:false,key:''}};Storage.saveProviders(next);return next}
