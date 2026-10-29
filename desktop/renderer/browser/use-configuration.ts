import {useEffect,useState} from 'react';
import {defaultConfiguration,readConfiguration,writeConfiguration} from './configuration';
export function useBrowserConfiguration(){
 const [configuration,setConfiguration]=useState(()=>typeof window==='undefined'?defaultConfiguration():readConfiguration(window.localStorage));
 const [storageError,setStorageError]=useState(false);
 useEffect(()=>{try{writeConfiguration(window.localStorage,configuration);setStorageError(false);}catch{setStorageError(true);}},[configuration]);
 return {configuration,setConfiguration,storageError};
}
