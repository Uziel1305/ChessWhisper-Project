package com.example.chesswhisper.ui.login;

import android.os.Bundle;
import android.content.Intent;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.example.chesswhisper.ui.home.HomeActivity;
import androidx.lifecycle.ViewModelProvider;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.auth.AuthRepository;
import com.example.chesswhisper.data.auth.SessionManager;
import com.example.chesswhisper.ui.register.RegisterActivity;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

// The launcher activity — and, per CLAUDE.md's "LoginActivity is the login
// screen" decision, the login screen itself, not a router to a separate one.
public class LoginActivity extends AppCompatActivity {
    private View loginForm;
    private View offlineState;
    private MaterialButton retryButton;
    private TextInputEditText usernameInput;
    private TextInputEditText passwordInput;
    private TextView errorText;
    private MaterialButton submitButton;
    private ProgressBar progressBar;
    private LoginViewModel viewModel;
    private final AuthRepository authRepository = new AuthRepository();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draws behind the status and navigation bars; the listener below then
        // pads the content back out from underneath them.
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_login);
        int base = getResources().getDimensionPixelSize(R.dimen.screen_padding);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            // setPadding replaces padding rather than adding to it, so the screen's
            // own 24dp is added here instead of being set in the layout XML.
            v.setPadding(
                    systemBars.left + base,
                    systemBars.top + base,
                    systemBars.right + base,
                    systemBars.bottom + base);
            return insets;
        });

        loginForm = findViewById(R.id.loginForm);
        offlineState = findViewById(R.id.offlineState);
        retryButton = findViewById(R.id.retryButton);
        usernameInput = findViewById(R.id.usernameInput);
        passwordInput = findViewById(R.id.passwordInput);
        errorText = findViewById(R.id.errorText);
        submitButton = findViewById(R.id.submitButton);
        progressBar = findViewById(R.id.progressBar);
        retryButton.setOnClickListener(v -> checkSessionOrShowLogin());

        checkSessionOrShowLogin();
    }

    // Runs the CW-18 startup check, and doubles as the Retry button's action:
    // a stored refresh token is not, on its own, proof of a live session —
    // this confirms it server-side before trusting it.
    private void checkSessionOrShowLogin() {
        if (!SessionManager.getInstance().hasSession()) {
            showLoginForm();
            return;
        }
        // Both other states stay hidden behind the spinner until this resolves.
        loginForm.setVisibility(View.GONE);
        offlineState.setVisibility(View.GONE);
        progressBar.setVisibility(View.VISIBLE);
        authRepository.refreshSession(new AuthRepository.RefreshCallback() {
            @Override
            public void onSuccess() {
                if (isFinishing() || isDestroyed()) return;
                startActivity(new Intent(LoginActivity.this, HomeActivity.class));
                finish();
            }

            @Override
            public void onSessionExpired() {
                // The repository already cleared local storage — this
                // device now has no session, same as a fresh install.
                if (isFinishing() || isDestroyed()) return;
                showLoginForm();
            }

            @Override
            public void onNetworkError() {
                // Session was left untouched — it might still be perfectly
                // valid, we just couldn't confirm that right now. Don't make
                // the user re-enter credentials for what may be a connectivity
                // blip: offer Retry instead of the login form.
                if (isFinishing() || isDestroyed()) return;
                progressBar.setVisibility(View.GONE);
                offlineState.setVisibility(View.VISIBLE);
            }
        });
    }

    // Wires up and reveals the login form. Called either immediately (no
    // stored session) or after the CW-18 startup check above concludes the
    // stored session can't be trusted.
    private void showLoginForm() {
        progressBar.setVisibility(View.GONE);
        offlineState.setVisibility(View.GONE);
        loginForm.setVisibility(View.VISIBLE);

        // Tied to this Activity, so the same instance comes back after a rotation.
        viewModel = new ViewModelProvider(this).get(LoginViewModel.class);
        // Observing with "this" as the owner: updates stop while the screen is not
        // visible and the subscription is dropped automatically on destroy.
        viewModel.getState().observe(this, this::render);

        // No validation here on purpose — the request goes out and the server
        // decides, so there is only one copy of the rules.
        submitButton.setOnClickListener(v -> viewModel.login(
                usernameInput.getText().toString(),
                passwordInput.getText().toString()
        ));
        // The "Don't have an account? Register" link.
        findViewById(R.id.registerLink).setOnClickListener(v ->
                startActivity(new Intent(this, RegisterActivity.class)));
    }

    // Single place that turns a state into what is on screen. Every branch sets
    // both the visible and the invisible case, so no stale spinner or error
    // survives into the next state.
    private void render(LoginViewModel.LoginState state) {
        if (state.status == LoginViewModel.Status.LOADING) {
            progressBar.setVisibility(View.VISIBLE);
            submitButton.setEnabled(false);
        } else {
            progressBar.setVisibility(View.GONE);
            submitButton.setEnabled(true);
        }
        if (state.status == LoginViewModel.Status.ERROR && state.error != null) {
            errorText.setText(state.error.getMessage());
            errorText.setVisibility(View.VISIBLE);
        } else {
            errorText.setVisibility(View.GONE);
        }
        if (state.status == LoginViewModel.Status.SUCCESS) {
            // The session is already saved (AuthRepository.login) — the only
            // thing left to do is take the user to the home screen.
            startActivity(new Intent(this, HomeActivity.class));
            finish();
        }
    }
}
