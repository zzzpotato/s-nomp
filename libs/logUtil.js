import dateFormat from 'dateformat';
import colors from 'colors';

const severityToColor = (severity, text) => {
    switch(severity){
        case 'special':
            return colors.cyan(text);
        case 'debug':
            return colors.green(text);
        case 'warning':
            return colors.yellow(text);
        case 'error':
            return colors.red(text);
        default:
            return colors.white(text);
    }
};

export default class PoolLogger {
    constructor(configuration) {
        this.logLevel = configuration.logLevel;
        this.logColors = configuration.logColors;
        
        this.logLevelInt = (() => {
            switch(configuration.logLevel) {
                case 'debug':
                    return 0;
                case 'warning':
                    return 1;
                case 'error':
                    return 2;
                default:
                    return 0;
            }
        })();
    }

    log(severity, system, component, text, subcat) {
        if (this.logLevelInt > this.severityToInt(severity)) return;

        const entryDesc = `${dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss')} [${system}]\t`;
        let logString;
        
        if (subcat){
            logString = `${entryDesc}(${component}) [${subcat}]\t${text}`;
        } else {
            logString = `${entryDesc}(${component})\t\t${text}`;
        }

        if (this.logColors){
            logString = severityToColor(severity, logString);
        }

        console.log(logString);
    }

    severityToInt(severity) {
        switch(severity) {
            case 'debug':
                return 0;
            case 'warning':
                return 1;
            case 'error':
                return 2;
            default:
                return 0;
        }
    }

    debug(system, component, text, subcat) {
        this.log('debug', system, component, text, subcat);
    }

    warning(system, component, text, subcat) {
        this.log('warning', system, component, text, subcat);
    }

    error(system, component, text, subcat) {
        this.log('error', system, component, text, subcat);
    }

    special(system, component, text, subcat) {
        this.log('special', system, component, text, subcat);
    }
}