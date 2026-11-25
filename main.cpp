#include <windows.h>
#include <filesystem>
#include <string>

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    namespace fs = std::filesystem;

    wchar_t modulePath[MAX_PATH];
    if (!GetModuleFileNameW(nullptr, modulePath, MAX_PATH)) {
        MessageBoxW(nullptr, L"Could not locate Blockhost.", L"Blockhost", MB_ICONERROR);
        return 1;
    }

    fs::path executable(modulePath);
    fs::path resources = executable.parent_path();
    fs::path electron = resources / L"resources" / L"app.asar";

    if (!fs::exists(electron)) {
        fs::path unpacked = executable.parent_path() / L"resources" / L"app";
        if (!fs::exists(unpacked / L"main.cjs")) {
            MessageBoxW(nullptr,
                L"Blockhost was not found in this installation. Reinstall the application.",
                L"Blockhost", MB_ICONERROR);
            return 1;
        }
    }

    std::wstring currentDirectory = executable.parent_path().wstring();
    SetCurrentDirectoryW(currentDirectory.c_str());
    ShellExecuteW(nullptr, L"open", executable.c_str(), nullptr,
                  currentDirectory.c_str(), SW_SHOWNORMAL);
    return 0;
}
