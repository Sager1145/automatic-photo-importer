import type { Exposure, Language } from '../shared';

export interface CaptureDateTime {date?:string;time?:string;timezone?:string;}
/** Format recorded components without converting the capture offset or using the host timezone. */
export function formatCaptureDateTime(value:string|undefined, language:Language):CaptureDateTime {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) return {};
  const [,year,month,day,hour,minute,second,fraction='',offset] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year),Number(month)-1,Number(day));
  calendar.setUTCHours(Number(hour),Number(minute),Number(second),0);
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month)-1 || calendar.getUTCDate() !== Number(day)
    || calendar.getUTCHours() !== Number(hour) || calendar.getUTCMinutes() !== Number(minute) || calendar.getUTCSeconds() !== Number(second)) return {};
  if (offset && offset !== 'Z' && (Number(offset.slice(1,3)) > 23 || Number(offset.slice(4)) > 59)) return {};
  const date = new Intl.DateTimeFormat(language,{dateStyle:'medium',calendar:'gregory',timeZone:'UTC'}).format(calendar);
  const time = new Intl.DateTimeFormat(language,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(calendar)+fraction;
  return {date,time,...(offset ? {timezone:offset === 'Z' || offset === '+00:00' ? 'UTC' : `UTC${offset}`} : {})};
}

export interface ExposureDisplay {lens?:string;aperture?:string;iso?:string;shutterSpeed?:string;focalLength?:string;exposureCompensation?:string;}
export function formatExposure(exposure:Exposure|undefined, language:Language):ExposureDisplay {
  if (!exposure) return {};
  const number = (value:number,options:Intl.NumberFormatOptions={}) => new Intl.NumberFormat(language,{useGrouping:false,maximumFractionDigits:2,...options}).format(value);
  const positive = (value:number|undefined):value is number => value !== undefined && Number.isFinite(value) && value > 0;
  const display:ExposureDisplay = {};
  if (exposure.lens?.trim()) display.lens = exposure.lens.trim();
  if (positive(exposure.aperture)) display.aperture = `f/${number(exposure.aperture)}`;
  if (positive(exposure.iso)) display.iso = number(exposure.iso);
  if (positive(exposure.focalLength)) display.focalLength = `${number(exposure.focalLength)} mm`;
  if (positive(exposure.exposureTime)) {
    const seconds = exposure.exposureTime;
    const denominator = Math.round(1/seconds);
    const fraction = denominator >= 2 && Math.abs(1/denominator-seconds)/seconds <= 0.001;
    display.shutterSpeed = fraction ? `1/${number(denominator,{maximumFractionDigits:0})} s` : `${number(seconds,{maximumSignificantDigits:4})} s`;
  }
  if (exposure.exposureCompensation !== undefined && Number.isFinite(exposure.exposureCompensation)) display.exposureCompensation = `${number(exposure.exposureCompensation,{signDisplay:'exceptZero'})} EV`;
  return display;
}
