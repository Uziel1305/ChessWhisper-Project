package com.example.chesswhisper.ui.home;

import android.os.Bundle;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.lifecycle.Observer;
import androidx.lifecycle.ViewModelProvider;

import com.example.chesswhisper.R;
import com.example.chesswhisper.data.auth.SessionManager;
import com.example.chesswhisper.ui.SessionAwareActivity;
import com.google.android.material.button.MaterialButton;

// The home screen. It only renders state — the username and rating come straight
// from GET /api/users/me and are never computed or cached here.

public class HomeActivity extends SessionAwareActivity {

    private View successGroup;
    private View errorGroup;
    private TextView usernameText;
    private TextView ratingText;
    private TextView errorText;
    private ProgressBar progressBar;
    private MaterialButton retryButton;
    private HomeViewModel viewModel;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draws behind the status and navigation bars; the listener below pads
        // the content back out from underneath them.
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_home);
        // Only the system bars here, unlike RegisterActivity. The app bar is
        // full-bleed, so the screen's own 24dp is applied per-section inside the
        // layout rather than to the root.
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.home), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            return insets;
        });
        errorGroup=findViewById(R.id.errorGroup);
        successGroup=findViewById(R.id.successGroup);
        usernameText=findViewById(R.id.usernameText);
        ratingText = findViewById(R.id.ratingText);
        errorText = findViewById(R.id.errorText);
        progressBar = findViewById(R.id.progressBar);
        retryButton = findViewById(R.id.retryButton);
        // Tied to this Activity, so the same instance comes back after rotation.
        viewModel= new ViewModelProvider(this).get(HomeViewModel.class);
        viewModel.getState().observe(this, new Observer<HomeViewModel.HomeState>() {
            @Override
            public void onChanged(HomeViewModel.HomeState homeState) {
                render(homeState);
            }
        });
        retryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                load();
            }
        });
        load();
    }
    private void load(){
        viewModel.load();
    }
    
    // Single place that turns a state into what is on screen. All three groups
    // are set unconditionally, so exactly one is visible however you got here
    // and no stale spinner or error survives into the next state.
    public void render(HomeViewModel.HomeState state) {
        progressBar.setVisibility(
                state.status == HomeViewModel.Status.LOADING ? View.VISIBLE : View.GONE);

        successGroup.setVisibility(
                state.status == HomeViewModel.Status.SUCCESS ? View.VISIBLE : View.GONE);

        errorGroup.setVisibility(
                state.status == HomeViewModel.Status.ERROR ? View.VISIBLE : View.GONE);

        if (state.status == HomeViewModel.Status.SUCCESS && state.profile != null) {
            usernameText.setText(state.profile.getUsername());
            ratingText.setText(String.valueOf(state.profile.getRating()));
        }

        if (state.status == HomeViewModel.Status.ERROR && state.error != null) {
            // clearSession() ran on the OkHttp thread before this callback was posted,
            // and apply() updates the in-memory map synchronously — so an ERROR with no
            // session left is always the logged-out case, never a retryable failure.
            if (!SessionManager.getInstance().hasSession()) {
                return;
            }
            errorText.setText(state.error.getMessage());
            retryButton.setEnabled(true);
        }
    }


}