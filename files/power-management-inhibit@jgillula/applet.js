const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Main = imports.ui.main;
const GnomeSession = imports.misc.gnomeSession;
const Settings = imports.ui.settings;


const UUID = 'power-management-inhibit@jgillula';

const INHIBIT_IDLE_FLAG = 8;
const INHIBIT_SLEEP_FLAG = 4;


function logInfo(message) {
    var stack = (new Error()).stack;
    var caller = stack.split('\n')[1].trim();
    var function_name = caller.split("@")[0];
    var file_and_line = caller.split("/").slice(-1)[0];
    global.log(function_name + "@" + file_and_line + ": " + message);
}

function getAllPropertyNames( obj ) {
    var props = [];

    do {
        Object.getOwnPropertyNames( obj ).forEach(function ( prop ) {
            if ( props.indexOf( prop ) === -1 ) {
                props.push( prop );
            }
        });
    } while ( obj = Object.getPrototypeOf( obj ) );

    return props;
}


class PowerManagementInhibitor {
    constructor(appId) {        
        this.appId = appId;
        this._reasonsByObjPath = new Map();
    }
    
    addInhibitor(objectPath, reason) {
        this._reasonsByObjPath.set(objectPath, reason);
    }
    
    updateInhibitor(objectPath, reason) {
        this.addInhibitor(objectPath, reason);
    }
    
    removeInhibitor(objectPath) {
        this._reasonsByObjPath.delete(objectPath);
    }

    get reasonsByObjPath() {
        return this._reasonsByObjPath;
    }
    
    hasInhibitor() {
        return !!this._reasonsByObjPath.size;
    }
}


class PowerManagementInhibitorManager {
    constructor(status_update_callback) {
        // Inhibitors indexed by app ID e.g. "org.gnome.Rhythmbox3".
        // Each inhibitor is associated with exactly one app ID and vice versa.
        this._itemsByAppId = new Map();
        
        // Inhibitor items indexed by object path e.g. "/org/gnome/SessionManager/Inhibitor42".
        // Multiple paths may point to the same item if an app creates multiple inhibitors.
        this._itemsByObjPath = {};
        
        this._updateId = 0; // light-weight way to abort an in-progress update (by incrementing)
              
        this.status = PowerManagementInhibitorManager.PowerManagementStates.UNKNOWN;
        this.explanation = "";
        
        this.sessionProxy = null;
        this.sessionCookie = null;
        this.sigAddedId = 0;
        this.sigRemovedId = 0;

        this._status_update_callback = status_update_callback;
        
        GnomeSession.SessionManager(Lang.bind(this, function(proxy, error) {
            if (error)
                return;

            this.sessionProxy = proxy;
            this.updateInhibitors();
            
            this.sigAddedId = this.sessionProxy.connectSignal(
                "InhibitorAdded", 
                Lang.bind(this, this.updateInhibitors)
            );
            
            this.sigRemovedId = this.sessionProxy.connectSignal(
                "InhibitorRemoved",
                Lang.bind(this, this.updateInhibitors)
            );
        }));
    }

    allowPowerManagement() {
        if (this.sessionCookie) {
            //logInfo("Allowing power management because this.sessionCookie=" + this.sessionCookie + ", note that status=" + this.status);
            //let sessionCookie = this.sessionCookie;
            //this.sessionCookie = null;
            this.sessionProxy.UninhibitRemote(this.sessionCookie, Lang.bind(this, function() {
                //logInfo("Now calling the uninhibit remote callback");
                this.sessionCookie = null;
                this.updateInhibitors();
            }));
        }
    }

    inhibitPowerManagement() {
        if(!this.sessionCookie) {
            //logInfo("Inhibiting power management because this.sessionCookie=" + this.sessionCookie + ", note that status=" + this.status);
            this.sessionCookie = -1;
            this.sessionProxy.InhibitRemote(UUID,
                                            0,
                                            "Applet preventing power management",
                                            INHIBIT_IDLE_FLAG,
                                            Lang.bind(this, function(cookie) {
                                                this.sessionCookie = cookie;
                                                
                                                this.updateInhibitors();
                                                
                                            }));
        }
        
    }
    
    togglePowerManagement() {
        if (!this.sessionCookie) {
            this.inhibitPowerManagement();
        } else if (this.sessionCookie) {
            this.allowPowerManagement();
        }
    }
    
    updateStatus(updateId) {
        if (updateId != this._updateId) {
            return;
        }

        let current_state = this.sessionProxy.InhibitedActions;
        let other_inhibitors_reasons = [];
        for(var key of this._itemsByAppId.keys()) {
            let item = this._itemsByAppId.get(key);
            for(var reason of item.reasonsByObjPath.values()) {
                other_inhibitors_reasons.push(item.appId + " (" + reason + ")");
            }
        }
        let other_inhibitors_explanation_section = "";
        for(var reason of other_inhibitors_reasons.slice(0, other_inhibitors_reasons.length-1)) {
            other_inhibitors_explanation_section += reason + ",\n";
        }
        if(!!other_inhibitors_reasons.length) {
            other_inhibitors_explanation_section += other_inhibitors_reasons[other_inhibitors_reasons.length-1];
        }

        let applet_explanation_section = "Power management is ";
        //logInfo("current_state=" + current_state + ", this.sessionCookie=" + this.sessionCookie + ", this._itemsByAppId.size=" + this._itemsByAppId.size);
        if ((current_state & INHIBIT_IDLE_FLAG ||
             current_state & INHIBIT_SLEEP_FLAG) &&
            this.sessionCookie &&
            this._itemsByAppId.size > 0) {
            this.status = PowerManagementInhibitorManager.PowerManagementStates.INHIBITED_BY_BOTH;
            applet_explanation_section += "inhibited by the applet and\n";
        } else if ((current_state & INHIBIT_IDLE_FLAG ||
                    current_state & INHIBIT_SLEEP_FLAG) &&
                   this.sessionCookie &&
                  this._itemsByAppId.size == 0) {
            this.status = PowerManagementInhibitorManager.PowerManagementStates.INHIBITED_BY_APPLET;
            applet_explanation_section += "inhibited by the applet";
        } else if((current_state & INHIBIT_IDLE_FLAG ||
                   current_state & INHIBIT_SLEEP_FLAG) &&
                  !this.sessionCookie &&
                  this._itemsByAppId.size > 0) {
            this.status = PowerManagementInhibitorManager.PowerManagementStates.INHIBITED_BY_OTHER;
            applet_explanation_section += "inhibited by\n";
        } else if(!(current_state & INHIBIT_IDLE_FLAG ||
                    current_state & INHIBIT_SLEEP_FLAG) &&
                  !this.sessionCookie &&
                  this._itemsByAppId.size == 0) {
            this.status = PowerManagementInhibitorManager.PowerManagementStates.ALLOWED;
            applet_explanation_section += "allowed";
        } else {
            this.status = PowerManagementInhibitorManager.PowerManagementStates.UNKNOWN;
            applet_explanation_section += "unknown";
        }
        this.explanation = applet_explanation_section + other_inhibitors_explanation_section;
                
        if(this._status_update_callback) {
            if( !!(this._status_update_callback && this._status_update_callback.constructor && this._status_update_callback.call && this._status_update_callback.apply)) {
                this._status_update_callback();
            }
        }       
    }
    
    resetInhibitors() {
        // Abort any in-progress update or else it may continue to add menu items 
        // even after we've cleared them.
        this._updateId++;
        
        this._itemsByAppId.clear();
        this._itemsByObjPath = {};
    }

    updateInhibitors() {
        let sessionProxy = this.sessionProxy;

        // Grab a new ID for this update while at the same time aborting any other in-progress 
        // update. We don't want to end up with duplicate menu items!
        let updateId = ++this._updateId;
        
        sessionProxy.GetInhibitorsRemote(Lang.bind(this, function(objectPaths) {
            if (updateId != this._updateId) {
                return;
            }
            
            objectPaths = String(objectPaths).split(','); // Given object, convert to string[].
            
            // Add items for any paths we haven't seen before, and keep track of the paths
            // iterated so we can figure out which of our existing paths are no longer present.            
            let pathsPresent = {};
            
            for (let objectPath of objectPaths) {
                if (objectPath) {
                    pathsPresent[objectPath] = true;                    
                    if (!(objectPath in this._itemsByObjPath)) {
                        this._addInhibitor(objectPath, updateId);                        
                    }
                }
            }
            
            // Remove menu items for those paths no longer present.
            for (let objectPath in this._itemsByObjPath) {
                if (!(objectPath in pathsPresent)) {
                    this._removeInhibitor(objectPath, updateId);
                }
            }
        }));
        this.updateStatus(updateId);
    }
    
    // Precondition: objectPath not already in _itemsByObjPath
    _addInhibitor(objectPath, updateId) {
        GnomeSession.Inhibitor(objectPath, Lang.bind(this, function(inhibitorProxy, error) {
            if (error || updateId != this._updateId) {
                return;
            }
            
            inhibitorProxy.GetFlagsRemote(Lang.bind(this, function(flags) {
                if (updateId != this._updateId) {
                    return;
                }
                
                flags = parseInt(flags, 10); // Given object, convert to integer.
                
                // Only include those inhibiting sleep, idle, or both.
                if (flags < INHIBIT_SLEEP_FLAG) {
                    return;
                }
                
                inhibitorProxy.GetAppIdRemote(Lang.bind(this, function(appId) {
                    if (updateId != this._updateId) {
                        return;
                    }
                    
                    appId = String(appId); // Given object, convert to string.

                    if(appId == UUID) {
                        this.updateStatus(updateId);
                        return;
                    }
                    
                    // Get/create the inhibitor item for this app.
                    let inhibitorItem = this._itemsByAppId.get(appId);
                    if (!inhibitorItem) {
                        inhibitorItem = new PowerManagementInhibitor(appId);
                        this._itemsByAppId.set(appId, inhibitorItem);
                    }
                    
                    this._itemsByObjPath[objectPath] = inhibitorItem;
                    inhibitorItem.addInhibitor(objectPath);

                    inhibitorProxy.GetReasonRemote(Lang.bind(this, function(reason) {
                        if (updateId != this._updateId) {
                            return;
                        }
                        
                        reason = String(reason); // Given object, convert to string.
                        inhibitorItem.updateInhibitor(objectPath, reason);
                        this.updateStatus(updateId);
                    }));
                }));
            }));
        }));
    }
    
    // Precondition: objectPath already in _itemsByObjPath
    _removeInhibitor(objectPath, updateId) {
        if(objectPath in this._itemsByObjPath) {
            let inhibitorItem = this._itemsByObjPath[objectPath];
            delete this._itemsByObjPath[objectPath];
            inhibitorItem.removeInhibitor(objectPath);
            
            // Remove the menu item if the last inhibitor for the app has been removed.
            if (!inhibitorItem.hasInhibitor()) {
                this._itemsByAppId.delete(inhibitorItem.appId);
            }
        }
        this.updateStatus(updateId);
    }

    kill() {
        if (!this.sessionProxy)
            return;

        if (this.sessionCookie) {
            this.sessionProxy.UninhibitRemote(this.sessionCookie);
            this.sessionCookie = null;
        }

        if (this.sigAddedId) {
            this.sessionProxy.disconnectSignal(this.sigAddedId);
        }
        
        if (this.sigRemovedId) {
            this.sessionProxy.disconnectSignal(this.sigRemovedId);
        }
    }

}
PowerManagementInhibitorManager.PowerManagementStates = {"ALLOWED": "allowed",
                                                         "INHIBITED_BY_APPLET": "inhibited_by_applet",
                                                         "INHIBITED_BY_OTHER": "inhibited_by_other",
                                                         "INHIBITED_BY_BOTH": "inhibited_by_both",
                                                         "UNKNOWN": "unknown"};



class PowerManagementInhibitApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panel_height, instanceId) {
        super(orientation, panel_height, instanceId);

        this.metadata = metadata;

        this.set_applet_icon_symbolic_name('inhibit');
        this.set_applet_tooltip(_("Inhibit applet"));

        this.uuid = UUID;

        this.inhibitorManager = new PowerManagementInhibitorManager(Lang.bind(this, this.update_icon));
        
        try {
            this.settings = new Settings.AppletSettings(this, this.uuid, instanceId);
            let settingsList = PowerManagementInhibitApplet.iconList.slice();
            for (const iconName of PowerManagementInhibitApplet.iconList){
                let additionalSetting = "use_custom_" + iconName;
                settingsList.push(additionalSetting);
            }
            for (const keybindingName of PowerManagementInhibitApplet.keybindingList){
                settingsList.push(keybindingName);
            }            
            for (const settingName of settingsList){                
                this.settings.bindProperty(Settings.BindingDirection.IN,
                                           settingName,
                                           settingName,
                                           this.on_settings_changed,
                                           null);
            }
        } catch (e) {
            global.logError(e);
            this.settings = null;
        }
              
        this.screensaver_settings_menu_item = new Applet.MenuItem(_("Screensaver settings"), 'system-run-symbolic',
                                                                  Lang.bind(this, this._screensaver_settings));
        this._applet_context_menu.addMenuItem(this.screensaver_settings_menu_item);

        this.power_management_settings_menu_item = new Applet.MenuItem(_("Power Management settings"), 'system-run-symbolic',
                                                                  Lang.bind(this, this._power_management_settings));
        this._applet_context_menu.addMenuItem(this.power_management_settings_menu_item);

        if (this.settings) {
            this.on_settings_changed();
        }
    }
    

    update_icon() {
        let status = this.inhibitorManager.status;
        let icon_name = "power_management_" + status + "_icon";

        if(this["use_custom_" + icon_name]) {
            if(this[icon_name +"_path_exists"]) {
                if (this[icon_name].indexOf("symbolic") > -1) {
                    this.set_applet_icon_symbolic_name(this[icon_name])
                } else {
                    this.set_applet_icon_path(this[icon_name]);
                }
            } else {
                if (this[icon_name].indexOf("symbolic") > -1) {
                    this.set_applet_icon_symbolic_name(this[icon_name])
                } else {
                    this.set_applet_icon_name(this[icon_name])
                }
            }            
        } else {
            this.set_applet_icon_symbolic_name(this.settings.settingsData[icon_name].default);
        }

        this.set_applet_tooltip(this.inhibitorManager.explanation);
    }
    
    on_settings_changed() {
        for (const keybindingName of PowerManagementInhibitApplet.keybindingList){
            if (this[keybindingName] && this[keybindingName] != "::") {
                let callback_function_name  = keybindingName.substr(0, keybindingName.indexOf("_")) + "_power_management";
                Main.keybindingManager.addHotKey(this.uuid + "." + keybindingName, this[keybindingName], Lang.bind(this, this[callback_function_name]));
            } else {
                Main.keybindingManager.removeHotKey(this.uuid + "." + keybindingName);
            }
        }            


        for (const iconName of PowerManagementInhibitApplet.iconList){
            if(this["use_custom_" + iconName]) {
                let file_path = Gio.file_new_for_path(this[iconName]);
                this[iconName + "_path_exists"] = file_path.query_exists(null);
            }
        }
        
        this.update_icon();
    }

    toggle_power_management() {
        
        this.inhibitorManager.togglePowerManagement();
        
    }

    allow_power_management() {
        this.inhibitorManager.allowPowerManagement();
    }

    inhibit_power_management() {
        this.inhibitorManager.inhibitPowerManagement();
    }    
    
    on_applet_clicked(event) {
        
        this.toggle_power_management();
        
    }

    on_applet_removed_from_panel() {
        this.inhibitorManager.kill();
    }
    
    _power_management_settings() {
        if (GLib.find_program_in_path("cinnamon-control-center")) {
            Util.spawn(['cinnamon-settings', 'power']);
        }
    }

    _screensaver_settings() {
        if (GLib.find_program_in_path("cinnamon-control-center")) {
            Util.spawn(['cinnamon-settings', 'screensaver']);
        }
    }
}
PowerManagementInhibitApplet.iconList = ["power_management_allowed_icon",
                                         "power_management_inhibited_by_applet_icon",                               
                                         "power_management_inhibited_by_other_icon",
                                         "power_management_inhibited_by_both_icon",
                                         "power_management_unknown_icon"];
PowerManagementInhibitApplet.keybindingList = ["toggle_keybinding",
                                               "allow_keybinding",
                                               "inhibit_keybinding"];



function main(metadata, orientation, panel_height, instanceId) {
    return new PowerManagementInhibitApplet(metadata, orientation, panel_height, instanceId);
}
