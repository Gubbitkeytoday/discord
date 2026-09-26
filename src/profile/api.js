// Thin wrappers over the profiles / cosmetics endpoints.

import { get, put, patch, post, del } from '../api';

const q = (serverId) => (serverId && serverId !== 'home' ? `?server_id=${encodeURIComponent(serverId)}` : '');

export const fetchProfile = (userId, serverId) => get(`/api/profiles/${encodeURIComponent(userId)}${q(serverId)}`);
export const fetchMyIdentity = () => get('/api/profiles/@me/identity');
export const updateMyIdentity = (body) => patch('/api/profiles/@me/identity', body);
export const setCustomStatus = (body) => put('/api/profiles/@me/custom-status', body);
export const equipCosmetics = (body, serverId) => put(`/api/cosmetics/@me${q(serverId)}`, body);
export const reportProfile = (userId, body) => post(`/api/profiles/${encodeURIComponent(userId)}/report`, body);
export const resetMemberProfile = (serverId, userId, body = {}) =>
  post(`/api/servers/${serverId}/members/${encodeURIComponent(userId)}/profile-reset`, body);

export const getServerTag = (serverId) => get(`/api/servers/${serverId}/tag`);
export const saveServerTag = (serverId, body) => put(`/api/servers/${serverId}/tag`, body);
export const deleteServerTag = (serverId) => del(`/api/servers/${serverId}/tag`);
export const getCosmeticsSettings = (serverId) => get(`/api/servers/${serverId}/cosmetics-settings`);
export const saveCosmeticsSettings = (serverId, body) => patch(`/api/servers/${serverId}/cosmetics-settings`, body);
export const listServerBadges = (serverId) => get(`/api/servers/${serverId}/badges`);
export const createServerBadge = (serverId, body) => post(`/api/servers/${serverId}/badges`, body);
export const deleteServerBadge = (serverId, badgeId) => del(`/api/servers/${serverId}/badges/${badgeId}`);
export const grantServerBadge = (serverId, badgeId, userId, revoke = false) =>
  (revoke ? del : put)(`/api/servers/${serverId}/badges/${badgeId}/members/${encodeURIComponent(userId)}`, revoke ? undefined : {});

export const listPacks = () => get('/api/admin/cosmetic-packs');
export const createPack = (body) => post('/api/admin/cosmetic-packs', body);
export const addPackItem = (packId, body) => post(`/api/admin/cosmetic-packs/${packId}/items`, body);
export const updatePack = (packId, body) => patch(`/api/admin/cosmetic-packs/${packId}`, body);
export const deletePack = (packId) => del(`/api/admin/cosmetic-packs/${packId}`);
export const validateSvg = (svg) => post('/api/admin/cosmetics/validate-svg', { svg });
