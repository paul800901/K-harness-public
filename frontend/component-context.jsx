import {createContext, useContext} from 'react';
import {selectionAllows} from '../shared/components.mjs';

export const ComponentContext = createContext(selectionAllows(undefined));
export const useComponentEnabled = () => useContext(ComponentContext);
