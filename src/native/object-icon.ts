import{fileIconType}from'../../sdk/src/file-icons.js';
import{isAppRegistration,appManifest}from'../../shared/app-desktop.mjs';
import{desktopFile}from'../../shared/desktop-placements.mjs';
import{kindIcon}from'./contracts';
import type{WorldObject}from'../types';
export function objectIcon(object:WorldObject){return isAppRegistration(object)?appManifest(object).desktop?.icon||'grid':desktopFile(object)?'file-'+fileIconType(object):kindIcon[object.kind]||'note';}
