import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NeuralwattUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Neuralwatt Usage Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure the Neuralwatt Usage extension',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'Configure how usage is shown in the top panel',
        });
        page.add(displayGroup);

        const displayModeRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'Show usage as text percentage, progress bar, or both',
        });

        const displayModeModel = new Gtk.StringList();
        displayModeModel.append('Text (percentage)');
        displayModeModel.append('Progress Bar');
        displayModeModel.append('Both');
        displayModeRow.set_model(displayModeModel);

        const currentMode = settings.get_string('display-mode');
        const modeIndex = currentMode === 'bar' ? 1 : currentMode === 'both' ? 2 : 0;
        displayModeRow.set_selected(modeIndex);

        displayModeRow.connect('notify::selected', () => {
            const selected = displayModeRow.get_selected();
            const modes = ['text', 'bar', 'both'];
            settings.set_string('display-mode', modes[selected]);
        });

        displayGroup.add(displayModeRow);

        const iconStyleRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'Use a color or monochrome icon in the panel',
        });

        const iconStyleModel = new Gtk.StringList();
        iconStyleModel.append('Color');
        iconStyleModel.append('Monochrome');
        iconStyleRow.set_model(iconStyleModel);

        const currentStyle = settings.get_string('icon-style');
        iconStyleRow.set_selected(currentStyle === 'monochrome' ? 1 : 0);

        iconStyleRow.connect('notify::selected', () => {
            const selected = iconStyleRow.get_selected();
            settings.set_string('icon-style', selected === 1 ? 'monochrome' : 'color');
        });

        displayGroup.add(iconStyleRow);

        const showIconRow = new Adw.SwitchRow({
            title: 'Show Icon',
            subtitle: 'Display the Neuralwatt icon in the top bar',
        });
        settings.bind(
            'show-icon',
            showIconRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(showIconRow);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Configure network settings',
        });
        page.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);

        const proxyHint = new Gtk.Label({
            label: 'Example: http://localhost:11809 (leave empty for no proxy)',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        networkGroup.add(proxyHint);

        const profilesGroup = new Adw.PreferencesGroup({
            title: 'Profiles',
            description: 'Configure multiple API keys and display them independently',
        });
        page.add(profilesGroup);

        let _profileRows = [];

        const renderProfiles = () => {
            _profileRows.forEach(row => profilesGroup.remove(row));
            _profileRows = [];

            let profiles = [];
            try {
                profiles = JSON.parse(settings.get_string('profiles'));
            } catch (e) {
                profiles = [{ name: 'Default', apiKey: '', showInPanel: true }];
            }

            profiles.forEach((profile, index) => {
                const row = new Adw.ActionRow({
                    title: profile.name,
                    subtitle: profile.apiKey ? 'API key set' : 'No API key',
                });

                const editButton = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });

                editButton.connect('clicked', () => {
                    const dialog = new Gtk.Dialog({
                        title: 'Edit Profile',
                        transient_for: window,
                        modal: true,
                        use_header_bar: 1,
                    });

                    const nameEntry = new Gtk.Entry({ placeholder_text: 'Profile Name', margin_bottom: 10 });
                    nameEntry.set_text(profile.name);
                    const apiKeyEntry = new Gtk.PasswordEntry({ placeholder_text: 'API Key (sk-...)', margin_bottom: 10, show_peek_icon: true });
                    apiKeyEntry.set_text(profile.apiKey || '');

                    const showInPanelBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, margin_bottom: 10, spacing: 10 });
                    const showInPanelLabel = new Gtk.Label({ label: 'Show in Panel', hexpand: true, xalign: 0 });
                    const showInPanelSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
                    showInPanelSwitch.set_active(profile.showInPanel !== false);
                    showInPanelBox.append(showInPanelLabel);
                    showInPanelBox.append(showInPanelSwitch);

                    const box = dialog.get_content_area();
                    box.set_margin_top(10);
                    box.set_margin_bottom(10);
                    box.set_margin_start(10);
                    box.set_margin_end(10);
                    box.append(nameEntry);
                    box.append(apiKeyEntry);
                    box.append(showInPanelBox);

                    dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
                    const saveBtn = dialog.add_button('Save', Gtk.ResponseType.OK);
                    saveBtn.get_style_context().add_class('suggested-action');

                    dialog.connect('response', (d, response) => {
                        if (response === Gtk.ResponseType.OK) {
                            profiles[index] = {
                                name: nameEntry.get_text(),
                                apiKey: apiKeyEntry.get_text(),
                                showInPanel: showInPanelSwitch.get_active()
                            };
                            settings.set_string('profiles', JSON.stringify(profiles));
                            renderProfiles();
                        }
                        d.destroy();
                    });

                    dialog.show();
                });

                const deleteButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'error'],
                });

                deleteButton.connect('clicked', () => {
                    profiles.splice(index, 1);
                    settings.set_string('profiles', JSON.stringify(profiles));
                    renderProfiles();
                });

                row.add_suffix(editButton);
                row.add_suffix(deleteButton);
                profilesGroup.add(row);
                _profileRows.push(row);
            });

            const addButton = new Gtk.Button({
                label: 'Add Profile',
                margin_top: 10,
                halign: Gtk.Align.CENTER,
            });

            addButton.connect('clicked', () => {
                const dialog = new Gtk.Dialog({
                    title: 'Add Profile',
                    transient_for: window,
                    modal: true,
                    use_header_bar: 1,
                });

                const nameEntry = new Gtk.Entry({ placeholder_text: 'Profile Name', margin_bottom: 10 });
                const apiKeyEntry = new Gtk.PasswordEntry({ placeholder_text: 'API Key (sk-...)', margin_bottom: 10, show_peek_icon: true });

                const showInPanelBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, margin_bottom: 10, spacing: 10 });
                const showInPanelLabel = new Gtk.Label({ label: 'Show in Panel', hexpand: true, xalign: 0 });
                const showInPanelSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
                showInPanelSwitch.set_active(true);
                showInPanelBox.append(showInPanelLabel);
                showInPanelBox.append(showInPanelSwitch);

                const box = dialog.get_content_area();
                box.set_margin_top(10);
                box.set_margin_bottom(10);
                box.set_margin_start(10);
                box.set_margin_end(10);
                box.append(nameEntry);
                box.append(apiKeyEntry);
                box.append(showInPanelBox);

                dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
                const addBtn = dialog.add_button('Add', Gtk.ResponseType.OK);
                addBtn.get_style_context().add_class('suggested-action');

                dialog.connect('response', (d, response) => {
                    if (response === Gtk.ResponseType.OK) {
                        profiles.push({
                            name: nameEntry.get_text(),
                            apiKey: apiKeyEntry.get_text(),
                            showInPanel: showInPanelSwitch.get_active()
                        });
                        settings.set_string('profiles', JSON.stringify(profiles));
                        renderProfiles();
                    }
                    d.destroy();
                });

                dialog.show();
            });

            profilesGroup.add(addButton);
            _profileRows.push(addButton);
        };

        renderProfiles();
    }
}
