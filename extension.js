import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://api.neuralwatt.com/v1/quota';
const ENERGY_API_URL = 'https://api.neuralwatt.com/v1/usage/energy';
const MAX_ERRORS = 50;
const MIN_REFRESH_INTERVAL = 5;
const REQUEST_TIMEOUT = 30;
const _decoder = new TextDecoder('utf-8');

const DEFAULT_PROFILES = [{name: 'Default', apiKey: '', showInPanel: true}];

const NeuralwattUsageIndicator = GObject.registerClass(
class NeuralwattUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Neuralwatt Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();
        this._errors = [];
        this._lastUpdated = null;
        this._fetchGeneration = 0;
        this._cancellable = null;
        this._destroyed = false;
        this._lastValidData = [];
        this._lastDailyData = [];

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'neuralwatt.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'neuralwatt-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelDataBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._panelDataBox);

        this.add_child(this._box);

        this._panelUIs = [];

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'profiles') {
                this._lastValidData = [];
                this._lastDailyData = [];
                this._buildProfilesMenu();
                this._buildPanelUIs(this._getProfiles());
                this._refreshUsage();
            }
        });

        this._menuOpenId = this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._updateLastUpdatedLabel();
            }
        });

        this._buildProfilesMenu();
        this._buildPanelUIs(this._getProfiles());

        this._updateIconVisibility();
        this._updateIconStyle();
        this._refreshUsage();
        this._startTimer();
    }

    _buildPanelUIs(profiles) {
        this._panelDataBox.destroy_all_children();
        this._panelUIs = new Array(profiles.length).fill(null);

        const visibleProfiles = profiles.filter(p => p.showInPanel !== false);
        const showNames = visibleProfiles.length > 1;

        let visibleIndex = 0;
        profiles.forEach((profile, index) => {
            if (profile.showInPanel === false) return;

            const container = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });

            let nameLabel = null;
            if (showNames) {
                nameLabel = new St.Label({
                    text: `${profile.name}: `,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'neuralwatt-usage-label',
                    style: 'margin-right: 2px;',
                });
                container.add_child(nameLabel);
            }

            const panelProgressBg = new St.Widget({
                style_class: 'neuralwatt-panel-progress-bg',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const panelProgressBar = new St.Widget({
                style_class: 'neuralwatt-panel-progress-bar',
            });
            panelProgressBg.add_child(panelProgressBar);
            container.add_child(panelProgressBg);

            const label = new St.Label({
                text: '...',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'neuralwatt-usage-label',
            });
            container.add_child(label);

            this._panelDataBox.add_child(container);

            if (visibleIndex < visibleProfiles.length - 1) {
                const separator = new St.Label({
                    text: ' • ',
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'neuralwatt-usage-label',
                    style: 'margin-left: 6px; margin-right: 6px;',
                });
                this._panelDataBox.add_child(separator);
            }

            this._panelUIs[index] = {
                nameLabel,
                panelProgressBg,
                panelProgressBar,
                label,
            };

            visibleIndex++;
        });

        this._updateDisplayMode();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        this._panelUIs.forEach(ui => {
            if (!ui) return;
            if (mode === 'bar') {
                ui.panelProgressBg.show();
                ui.label.hide();
                ui.label.set_style('margin-left: 0;');
            } else if (mode === 'both') {
                ui.panelProgressBg.show();
                ui.label.show();
                ui.label.set_style('margin-left: 6px;');
            } else {
                ui.panelProgressBg.hide();
                ui.label.show();
                ui.label.set_style('margin-left: 0;');
            }
        });
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createSession() {
        const session = new Soup.Session({timeout: REQUEST_TIMEOUT, idle_timeout: REQUEST_TIMEOUT});
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._cancellable) {
            this._cancellable.cancel();
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        this._session = this._createSession();
        this._refreshUsage();
    }

    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
    }

    _getProfiles() {
        try {
            const parsed = JSON.parse(this._settings.get_string('profiles'));
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        } catch (e) {
        }
        return DEFAULT_PROFILES;
    }

    _createDetailRow(labelText) {
        const box = new St.BoxLayout({ vertical: false, x_expand: true });
        const fieldLabel = new St.Label({
            text: `${labelText}:`,
            style_class: 'neuralwatt-field-label',
        });
        const valueLabel = new St.Label({
            text: '—',
            style_class: 'neuralwatt-reset-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        box.add_child(fieldLabel);
        box.add_child(valueLabel);
        return {box, valueLabel};
    }

    _buildProfilesMenu() {
        this.menu.removeAll();

        const profiles = this._getProfiles();

        this._profileUIs = [];

        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const headerBox = new St.BoxLayout({
            style_class: 'neuralwatt-header-box',
            vertical: false,
            x_expand: true,
        });

        const refreshTokenIcon = new St.Icon({
            gicon: Gio.ThemedIcon.new('view-refresh-symbolic'),
            icon_size: 14,
        });
        const refreshButton = new St.Button({
            child: refreshTokenIcon,
            style_class: 'neuralwatt-refresh-button',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        refreshButton.connect('clicked', () => this._refreshUsage());
        headerBox.add_child(refreshButton);
        headerItem.add_child(headerBox);
        this.menu.addMenuItem(headerItem);

        const showProfileName = profiles.length > 1;

        for (const profile of profiles) {
            const profileItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const profileBox = new St.BoxLayout({
                style_class: 'neuralwatt-usage-section',
                vertical: true,
            });

            if (showProfileName) {
                const nameLabel = new St.Label({
                    text: profile.name,
                    style_class: 'neuralwatt-section-title',
                    style: 'font-weight: bold; margin-bottom: 8px;',
                });
                profileBox.add_child(nameLabel);
            }

            const usageHeader = new St.BoxLayout({ vertical: false });
            const usageLabel = new St.Label({
                text: 'Usage',
                style_class: 'neuralwatt-section-title',
            });
            usageHeader.add_child(usageLabel);
            const percentLabel = new St.Label({
                text: '...',
                style_class: 'neuralwatt-percent-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            usageHeader.add_child(percentLabel);
            profileBox.add_child(usageHeader);

            const progressBg = new St.Widget({
                style_class: 'neuralwatt-progress-bg',
            });
            const progressBar = new St.Widget({
                style_class: 'neuralwatt-progress-bar usage-low',
            });
            progressBg.add_child(progressBar);
            profileBox.add_child(progressBg);

            const detailsLabel = new St.Label({
                text: '...',
                style_class: 'neuralwatt-reset-label detail-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            profileBox.add_child(detailsLabel);

            const resetRow = this._createDetailRow('Resets');
            profileBox.add_child(resetRow.box);

            const creditsRow = this._createDetailRow('Available credits');
            profileBox.add_child(creditsRow.box);

            const sectionSeparator = new St.Widget({
                style_class: 'neuralwatt-section-separator',
            });
            profileBox.add_child(sectionSeparator);

            const todayLabel = new St.Label({
                text: 'Today',
                style_class: 'neuralwatt-today-title',
            });
            profileBox.add_child(todayLabel);

            const todayRequestsRow = this._createDetailRow('Requests');
            profileBox.add_child(todayRequestsRow.box);
            const todayEnergyRow = this._createDetailRow('Energy');
            profileBox.add_child(todayEnergyRow.box);

            profileItem.add_child(profileBox);
            this.menu.addMenuItem(profileItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._profileUIs.push({
                percentLabel,
                progressBar,
                detailsLabel,
                resetValueLabel: resetRow.valueLabel,
                creditsValueLabel: creditsRow.valueLabel,
                todayRequestsLabel: todayRequestsRow.valueLabel,
                todayEnergyLabel: todayEnergyRow.valueLabel,
            });
        }

        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const footerBox = new St.BoxLayout({
            style_class: 'neuralwatt-footer-box',
            vertical: false,
            x_expand: true,
        });

        this._lastUpdatedLabel = new St.Label({
            text: 'Updated: never',
            style_class: 'neuralwatt-footer-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        footerBox.add_child(this._lastUpdatedLabel);

        this._errorButton = new St.Button({
            label: 'Error',
            style_class: 'neuralwatt-error-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this._errorButton.connect('clicked', () => this._showErrorLog());
        footerBox.add_child(this._errorButton);

        footerItem.add_child(footerBox);
        this.menu.addMenuItem(footerItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);

        this._updateLastUpdatedLabel();
        this._updateErrorButton();
    }

    _startTimer() {
        if (this._timerId) {
            return;
        }
        let interval = this._settings.get_int('refresh-interval');
        if (!Number.isFinite(interval) || interval < MIN_REFRESH_INTERVAL) {
            interval = MIN_REFRESH_INTERVAL;
        }
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _refreshUsage() {
        if (this._destroyed) {
            return;
        }

        this._fetchGeneration++;
        if (this._cancellable) {
            this._cancellable.cancel();
        }
        this._cancellable = new Gio.Cancellable();
        const generation = this._fetchGeneration;
        const cancellable = this._cancellable;

        const profiles = this._getProfiles();

        if (this._profileUIs?.length !== profiles.length) {
            this._buildProfilesMenu();
        }
        if (this._panelUIs?.length !== profiles.length) {
            this._buildPanelUIs(profiles);
        }

        profiles.forEach((profile, index) => {
            if (!profile.apiKey || profile.apiKey.trim() === '') {
                this._updateProfileDisplay(index, null, 'Set API key', '—');
                this._updateDailyDisplay(index, null);
                return;
            }
            this._fetchUsage(profile, index, generation, cancellable);
            this._fetchDailyUsage(profile, index, generation, cancellable);
        });
    }

    _fetchUsage(profile, index, generation, cancellable) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${profile.apiKey}`);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                if (this._destroyed || generation !== this._fetchGeneration) {
                    return;
                }
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        const errMsg = `HTTP ${message.status_code}`;
                        this._addError(profile.name, errMsg);
                        if (!this._lastValidData[index]) {
                            this._updateProfileDisplay(index, null, errMsg);
                        }
                        return;
                    }

                    const data = JSON.parse(_decoder.decode(bytes.get_data()));

                    this._lastValidData[index] = data;
                    this._updateProfileDisplay(index, data);
                    this._lastUpdated = Date.now();
                    this._updateLastUpdatedLabel();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    const errMsg = e.message || 'Unknown error';
                    this._addError(profile.name, errMsg);
                    if (!this._lastValidData[index]) {
                        this._updateProfileDisplay(index, null, 'Error');
                    }
                }
            }
        );
    }

    _fetchDailyUsage(profile, index, generation, cancellable) {
        const now = GLib.DateTime.new_now_local();
        const todayStr = now.format('%Y-%m-%d');
        const tomorrowStr = now.add_days(1).format('%Y-%m-%d');
        const url = `${ENERGY_API_URL}?start_date=${todayStr}&end_date=${tomorrowStr}`;

        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', `Bearer ${profile.apiKey}`);

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                if (this._destroyed || generation !== this._fetchGeneration) {
                    return;
                }
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        const errMsg = `Daily: HTTP ${message.status_code}`;
                        this._addError(profile.name, errMsg);
                        if (!this._lastDailyData[index]) {
                            this._updateDailyDisplay(index, null);
                        }
                        return;
                    }

                    const data = JSON.parse(_decoder.decode(bytes.get_data()));

                    this._lastDailyData[index] = data;
                    this._updateDailyDisplay(index, data);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        return;
                    }
                    const errMsg = `Daily: ${e.message || 'Unknown error'}`;
                    this._addError(profile.name, errMsg);
                    if (!this._lastDailyData[index]) {
                        this._updateDailyDisplay(index, null);
                    }
                }
            }
        );
    }

    _updateDailyDisplay(index, data) {
        if (!this._profileUIs || !this._profileUIs[index]) return;
        const ui = this._profileUIs[index];

        if (!data) {
            ui.todayRequestsLabel.set_text('—');
            ui.todayEnergyLabel.set_text('—');
            return;
        }

        const requests = data.totals?.requests ?? 0;
        const kwh = data.totals?.energy_kwh ?? 0;
        ui.todayRequestsLabel.set_text(`${requests}`);
        ui.todayEnergyLabel.set_text(`${kwh.toFixed(2)} kWh`);
    }

    _addError(profileName, message) {
        this._errors.unshift({
            profile: profileName,
            message: message,
            timestamp: Date.now(),
        });
        if (this._errors.length > MAX_ERRORS) {
            this._errors.length = MAX_ERRORS;
        }
        this._updateErrorButton();
    }

    _clearErrors() {
        this._errors = [];
        this._updateErrorButton();
    }

    _updateErrorButton() {
        if (!this._errorButton) return;
        this._errorButton.visible = this._errors.length > 0;
    }

    _formatRelativeTime(ms) {
        const diffSec = Math.floor(ms / 1000);
        if (diffSec < 60) return `${diffSec}s ago`;
        const diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        const diffDay = Math.floor(diffHr / 24);
        return `${diffDay}d ago`;
    }

    _updateLastUpdatedLabel() {
        if (!this._lastUpdatedLabel) return;
        if (this._lastUpdated) {
            const relative = this._formatRelativeTime(Date.now() - this._lastUpdated);
            this._lastUpdatedLabel.set_text(`Updated: ${relative}`);
        } else {
            this._lastUpdatedLabel.set_text('Updated: never');
        }
    }

    _showErrorLog() {
        const dialog = new ModalDialog.ModalDialog({
            shellReactive: true,
        });

        const contentBox = new St.BoxLayout({
            vertical: true,
            style: 'padding: 12px; spacing: 8px;',
        });

        const title = new St.Label({
            text: 'Errors',
            style_class: 'neuralwatt-section-title',
            style: 'font-size: 14px; font-weight: bold; margin-bottom: 4px;',
        });
        contentBox.add_child(title);

        const scrollView = new St.ScrollView({
            style_class: 'neuralwatt-error-scroll',
            x_expand: true,
            y_expand: true,
            style: 'max-height: 300px;',
        });
        scrollView.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);

        const errorList = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 4px;',
        });

        this._errors.forEach(err => {
            const date = new Date(err.timestamp);
            const timeStr = date.toLocaleTimeString();
            const dateStr = date.toLocaleDateString();
            const entryLabel = new St.Label({
                text: `[${dateStr} ${timeStr}] ${err.profile}: ${err.message}`,
                style: 'font-size: 11px; font-family: monospace; color: #ef4444; padding: 2px 0;',
            });
            errorList.add_child(entryLabel);
        });

        scrollView.add_child(errorList);
        contentBox.add_child(scrollView);

        const buttonBox = new St.BoxLayout({
            vertical: false,
            style: 'margin-top: 8px;',
        });

        const clearButton = new St.Button({
            label: 'Clear Errors',
            style_class: 'neuralwatt-error-clear-button',
        });
        clearButton.connect('clicked', () => {
            this._clearErrors();
            dialog.close();
        });
        buttonBox.add_child(clearButton);

        contentBox.add_child(buttonBox);

        dialog.contentLayout.add_child(contentBox);
        dialog.open();
    }

    _updateProfileDisplay(index, data, errorMsg = null, panelText = 'Err') {
        if (!this._profileUIs || !this._profileUIs[index]) return;
        const ui = this._profileUIs[index];
        const panelUi = this._panelUIs && this._panelUIs[index] ? this._panelUIs[index] : null;

        if (errorMsg) {
            ui.percentLabel.set_text(errorMsg);
            ui.detailsLabel.set_text('—');
            ui.resetValueLabel.set_text('—');
            ui.creditsValueLabel.set_text('—');
            ui.todayRequestsLabel.set_text('—');
            ui.todayEnergyLabel.set_text('—');
            if (panelUi) {
                panelUi.label.set_text(panelText);
                this._updatePanelProgressBar(panelUi.panelProgressBar, 0);
            }
            return;
        }

        const kwhIncluded = data.subscription?.kwh_included ?? 0;
        const kwhUsed = data.subscription?.kwh_used ?? 0;
        const periodEnd = data.subscription?.current_period_end;

        const usagePercent = kwhIncluded > 0 ? (kwhUsed / kwhIncluded) * 100 : 0;

        ui.percentLabel.set_text(`${usagePercent.toFixed(0)}%`);
        this._updateProgressBar(ui.progressBar, usagePercent);

        const usedStr = kwhUsed.toFixed(2);
        const includedStr = kwhIncluded.toFixed(0);
        ui.detailsLabel.set_text(`${usedStr} / ${includedStr} kWh`);

        ui.resetValueLabel.set_text(periodEnd ? this._formatPeriodEnd(periodEnd) : '—');

        const creditsRemaining = data.balance?.credits_remaining_usd;
        ui.creditsValueLabel.set_text(
            typeof creditsRemaining === 'number'
                ? `$${creditsRemaining.toFixed(2)}`
                : '—'
        );

        if (panelUi) {
            panelUi.label.set_text(`${Math.round(usagePercent)}%`);
            this._updatePanelProgressBar(panelUi.panelProgressBar, usagePercent);
        }
    }

    _updatePanelProgressBar(progressBar, usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);
    }

    _updateProgressBar(progressBar, usage) {
        const maxWidth = 200;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (usage >= 95) {
            progressBar.add_style_class_name('usage-critical');
        } else if (usage >= 90) {
            progressBar.add_style_class_name('usage-high');
        } else if (usage >= 75) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _formatPeriodEnd(isoString) {
        try {
            const endDate = new Date(isoString);
            return endDate.toLocaleDateString();
        } catch (e) {
            return 'unknown';
        }
    }

    destroy() {
        this._destroyed = true;
        this._stopTimer();
        this._fetchGeneration++;
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._panelUIs = null;
        this._profileUIs = null;
        this._errors = null;
        this._lastValidData = null;
        this._lastDailyData = null;
        super.destroy();
    }
});

export default class NeuralwattUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new NeuralwattUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
