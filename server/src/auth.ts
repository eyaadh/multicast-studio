import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { adminPassword, adminUser, sessionSecret } from './config.js'
import type { Context } from 'hono'

const cookieName = 'multicast_session'
const makeSignature = (message: string) => createHmac('sha256',sessionSecret).update(message).digest('base64url')
const constantEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x,y)
}
export function verifyCredentials(user: string, password: string) {
  return constantEqual(user,adminUser) && constantEqual(password,adminPassword)
}
export function makeSession(c: Context) {
  const payload = Buffer.from(JSON.stringify({exp:Date.now()+12*3600*1000, n:randomBytes(12).toString('hex')})).toString('base64url')
  setCookie(c,cookieName,`${payload}.${makeSignature(payload)}`,{
    httpOnly:true, sameSite:'Lax', secure:process.env.COOKIE_SECURE === 'true',
    path:'/',maxAge:12*3600
  })
}
export function isAuthenticated(c: Context): boolean {
  const token = getCookie(c,cookieName)
  if (!token) return false
  const [data,sig,extra] = token.split('.')
  if (!data || !sig || extra || !constantEqual(sig,makeSignature(data))) return false
  try {const payload = JSON.parse(Buffer.from(data,'base64url').toString('utf8')) as {exp?:number}; return typeof payload.exp === 'number' && payload.exp > Date.now() }
  catch {return false}
}
export function logout(c: Context) {deleteCookie(c,cookieName,{path:'/'})}
const loginAttempts = new Map<string,{count:number, since:number}>()
export function loginAllowed(ip: string) {
  const entry = loginAttempts.get(ip)
  if (!entry || Date.now()-entry.since > 15*60*1000) {loginAttempts.delete(ip);return true}
  return entry.count < 8
}
export function loginFailed(ip: string) {
  const entry = loginAttempts.get(ip)
  if (!entry || Date.now()-entry.since>15*60*1000) loginAttempts.set(ip,{count:1,since:Date.now()})
  else entry.count++
}
export function clearFailures(ip: string) {loginAttempts.delete(ip)}
