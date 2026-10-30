export const intakeSource = value => value === 'chiritumo' ? 'chiritumo' : 'arunomatic';
export function requestIntakeSource(url) {
 const value=url.searchParams.get('intake_source');
 if(value!==null&&!['arunomatic','chiritumo'].includes(value))throw Object.assign(new Error('受信元が正しくありません'),{status:400});
 return intakeSource(value);
}
