import {IntakeError} from './sending-auth.js';
export const intakeSource = value => value === 'chiritumo' ? 'chiritumo' : 'arunomatic';
export function requestIntakeSource(url) {
 const value=url.searchParams.get('intake_source');
 if(value!==null&&!['arunomatic','chiritumo'].includes(value))throw new IntakeError('INVALID_SOURCE',400,'受信元が正しくありません');
 return intakeSource(value);
}
